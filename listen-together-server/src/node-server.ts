/**
 * Node runtime for Convx Sync.
 *
 * The Cloudflare Worker uses Durable Objects for persistence and hibernation.
 * Replit and ordinary Node hosts do not have that runtime, so this file keeps
 * the same JSON/WebSocket protocol in memory. It is intentionally separate
 * from the Worker entry point instead of weakening the production DO design.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { TEST_CLIENT_HTML } from './testclient';
import type { ControlMode, RoomState, TrackInfo, UserInfo } from './protocol';

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.API_KEY?.trim() || '';
const PUBLIC_URL = process.env.PUBLIC_URL?.trim() || `http://localhost:${PORT}`;
const ROOM_TTL_MS = Math.max(1, Number(process.env.ROOM_TTL_HOURS ?? 6)) * 3600_000;
const MAX_EXTENSIONS = Math.max(0, Number(process.env.MAX_EXTENSIONS ?? 2));
const MAX_MEMBERS = Math.max(1, Number(process.env.MAX_MEMBERS ?? 20));
const MAX_BODY_BYTES = 128 * 1024;
const HOST_GRACE_MS = 90_000;
const BUFFER_TIMEOUT_MS = 10_000;
const EXPIRY_WARNING_MS = 10 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const C2S = {
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  APPROVE_JOIN: 'approve_join',
  REJECT_JOIN: 'reject_join',
  PLAYBACK_ACTION: 'playback_action',
  BUFFER_READY: 'buffer_ready',
  KICK_USER: 'kick_user',
  TRANSFER_HOST: 'transfer_host',
  PING: 'ping',
  CHAT: 'chat',
  REQUEST_SYNC: 'request_sync',
  RECONNECT: 'reconnect',
  SUGGEST_TRACK: 'suggest_track',
  APPROVE_SUGGESTION: 'approve_suggestion',
  REJECT_SUGGESTION: 'reject_suggestion',
  SET_CONTROL_MODE: 'set_control_mode',
  EXTEND_SESSION: 'extend_session',
} as const;

const S2C = {
  ROOM_CREATED: 'room_created',
  JOIN_REQUEST: 'join_request',
  JOIN_APPROVED: 'join_approved',
  JOIN_REJECTED: 'join_rejected',
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  SYNC_PLAYBACK: 'sync_playback',
  BUFFER_WAIT: 'buffer_wait',
  BUFFER_COMPLETE: 'buffer_complete',
  ERROR: 'error',
  PONG: 'pong',
  HOST_CHANGED: 'host_changed',
  KICKED: 'kicked',
  SYNC_STATE: 'sync_state',
  RECONNECTED: 'reconnected',
  USER_RECONNECTED: 'user_reconnected',
  USER_DISCONNECTED: 'user_disconnected',
  CHAT: 'chat',
  SUGGESTION_RECEIVED: 'suggestion_received',
  SUGGESTION_APPROVED: 'suggestion_approved',
  SUGGESTION_REJECTED: 'suggestion_rejected',
  CONTROL_MODE_CHANGED: 'control_mode_changed',
  ROOM_EXPIRING: 'room_expiring',
  ROOM_CLOSED: 'room_closed',
} as const;

type Connection = {
  ws: WebSocket;
  userId?: string;
  pendingId?: string;
};

type Member = {
  userId: string;
  username: string;
  sessionToken: string;
  connection?: Connection;
  joinedAt: number;
};

type PendingJoin = {
  userId: string;
  username: string;
  sessionToken: string;
  connection: Connection;
};

type Suggestion = {
  suggestionId: string;
  fromUserId: string;
  fromUsername: string;
  trackInfo: TrackInfo;
};

type BlendTrack = {
  track: TrackInfo;
  participants: Set<string>;
};

type Blend = {
  code: string;
  createdAt: number;
  members: Map<string, number>;
  tracks: Map<string, BlendTrack>;
};

type BufferWait = {
  trackId: string;
  waitingFor: Set<string>;
  timer: ReturnType<typeof setTimeout>;
};

function message(type: string, payload?: unknown): string {
  return JSON.stringify(payload === undefined ? { type } : { type, payload });
}

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeTrack(value: unknown): TrackInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (typeof value.title !== 'string' || typeof value.artist !== 'string') return null;
  const duration = finiteNumber(value.duration) ? Math.max(0, value.duration) : 0;
  return {
    id: value.id.trim(),
    title: value.title.trim().slice(0, 500),
    artist: value.artist.trim().slice(0, 500),
    album: typeof value.album === 'string' ? value.album.slice(0, 500) : null,
    duration,
    thumbnail: typeof value.thumbnail === 'string' ? value.thumbnail.slice(0, 2000) : null,
    suggested_by: typeof value.suggested_by === 'string' ? value.suggested_by.slice(0, 120) : null,
  };
}

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw)).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function authorized(request: IncomingMessage): boolean {
  if (!API_KEY) return true;
  const supplied = request.headers['x-api-key'] ??
    request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return typeof supplied === 'string' && supplied === API_KEY;
}

function writeJson(response: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-api-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  response.end(data);
}

function writeText(response: ServerResponse, body: string, status = 200, contentType = 'text/plain'): void {
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(part);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(parsed)) throw new Error('request body must be a JSON object');
  return parsed;
}

class Room {
  readonly code: string;
  private readonly members = new Map<string, Member>();
  private readonly tokens = new Map<string, string>();
  private readonly pending = new Map<string, PendingJoin>();
  private readonly suggestions = new Map<string, Suggestion>();
  private readonly connections = new Set<Connection>();
  private currentTrack: TrackInfo | null = null;
  private isPlaying = false;
  private position = 0;
  private lastUpdate = Date.now();
  private volume = 1;
  private queue: TrackInfo[] = [];
  private controlMode: ControlMode = 'owner';
  private readonly createdAt = Date.now();
  private expiresAt = this.createdAt + ROOM_TTL_MS;
  private extensionsUsed = 0;
  private warned = false;
  private expiryTimer: ReturnType<typeof setTimeout>;
  private warningTimer: ReturnType<typeof setTimeout>;
  private hostGraceTimer?: ReturnType<typeof setTimeout>;
  private buffer?: BufferWait;
  private readonly onExpired: (room: Room) => void;

  constructor(code: string, onExpired: (room: Room) => void) {
    this.code = code;
    this.onExpired = onExpired;
    this.expiryTimer = setTimeout(() => this.expire(), ROOM_TTL_MS);
    this.warningTimer = setTimeout(() => this.warnOfExpiry(), Math.max(0, ROOM_TTL_MS - EXPIRY_WARNING_MS));
  }

  attach(ws: WebSocket): void {
    const connection: Connection = { ws };
    this.connections.add(connection);
    ws.on('message', (raw) => void this.onMessage(connection, raw));
    ws.on('close', () => this.onClose(connection));
    ws.on('error', () => this.onClose(connection));
  }

  private send(connection: Connection, type: string, payload?: unknown): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    connection.ws.send(message(type, payload));
  }

  private broadcast(type: string, payload?: unknown, exceptUserId?: string): void {
    const data = message(type, payload);
    for (const connection of this.connections) {
      if (!connection.userId || connection.userId === exceptUserId) continue;
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(data);
    }
  }

  private error(connection: Connection, code: string, text: string): void {
    this.send(connection, S2C.ERROR, { code, message: text });
  }

  private snapshot(): RoomState {
    const hostId = this.hostId() ?? '';
    const users: UserInfo[] = Array.from(this.members.values()).map((member) => ({
      user_id: member.userId,
      username: member.username,
      is_host: member.userId === hostId,
      is_connected: Boolean(member.connection),
    }));
    return {
      room_code: this.code,
      host_id: hostId,
      users,
      current_track: this.currentTrack,
      is_playing: this.isPlaying,
      position: this.position,
      last_update: this.lastUpdate,
      volume: this.volume,
      queue: this.queue,
      control_mode: this.controlMode,
      expires_at: this.expiresAt,
      extensions_used: this.extensionsUsed,
    };
  }

  private hostId(): string | undefined {
    for (const member of this.members.values()) {
      if ((member as Member & { isHost?: boolean }).isHost) return member.userId;
    }
    return undefined;
  }

  private setHost(userId: string | undefined): void {
    for (const member of this.members.values()) {
      (member as Member & { isHost?: boolean }).isHost = member.userId === userId;
    }
  }

  private isHost(userId: string): boolean {
    return this.hostId() === userId;
  }

  private canControl(userId: string): boolean {
    return this.controlMode === 'everyone' || this.isHost(userId);
  }

  private async onMessage(connection: Connection, raw: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(raw));
    } catch {
      return this.error(connection, 'bad_message', 'malformed json');
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      return this.error(connection, 'bad_message', 'message type required');
    }
    const payload = isRecord(parsed.payload) ? parsed.payload : {};

    switch (parsed.type) {
      case C2S.PING:
        return this.send(connection, S2C.PONG);
      case C2S.CREATE_ROOM:
        return this.create(connection, payload.username);
      case C2S.JOIN_ROOM:
        return this.join(connection, payload.username);
      case C2S.RECONNECT:
        return this.reconnect(connection, payload.session_token);
    }

    const userId = connection.userId;
    if (!userId || !this.members.has(userId)) {
      return this.error(connection, 'not_in_room', 'join first');
    }
    switch (parsed.type) {
      case C2S.LEAVE_ROOM:
        return this.remove(userId, 'left');
      case C2S.APPROVE_JOIN:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        return this.approveJoin(payload.user_id);
      case C2S.REJECT_JOIN:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        return this.rejectJoin(payload.user_id, payload.reason);
      case C2S.PLAYBACK_ACTION:
        if (!this.canControl(userId)) return this.error(connection, 'forbidden', 'control is owner-only');
        return this.playback(userId, payload);
      case C2S.SET_CONTROL_MODE:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        if (payload.control_mode !== 'owner' && payload.control_mode !== 'everyone') {
          return this.error(connection, 'bad_control_mode', 'control_mode must be owner or everyone');
        }
        this.controlMode = payload.control_mode;
        return this.broadcast(S2C.CONTROL_MODE_CHANGED, { control_mode: this.controlMode });
      case C2S.EXTEND_SESSION:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        if (this.extensionsUsed >= MAX_EXTENSIONS) return this.error(connection, 'extend_limit', 'no extensions left');
        this.extensionsUsed += 1;
        this.expiresAt += ROOM_TTL_MS;
        this.warned = false;
        this.resetTimers();
        return this.broadcast(S2C.SYNC_STATE, this.syncPayload());
      case C2S.KICK_USER:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        return this.kick(payload.user_id, payload.reason);
      case C2S.TRANSFER_HOST:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        return this.transferHost(payload.new_host_id);
      case C2S.REQUEST_SYNC:
        return this.send(connection, S2C.SYNC_STATE, this.syncPayload());
      case C2S.BUFFER_READY:
        return this.bufferReady(userId, payload.track_id);
      case C2S.CHAT:
        return this.chat(userId, payload);
      case C2S.SUGGEST_TRACK:
        return this.suggest(userId, payload.track_info);
      case C2S.APPROVE_SUGGESTION:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        return this.resolveSuggestion(payload.suggestion_id, true, null);
      case C2S.REJECT_SUGGESTION:
        if (!this.isHost(userId)) return this.error(connection, 'forbidden', 'not host');
        return this.resolveSuggestion(payload.suggestion_id, false, payload.reason);
      default:
        return this.error(connection, 'unknown_type', parsed.type);
    }
  }

  private async create(connection: Connection, username: unknown): Promise<void> {
    if (typeof username !== 'string' || !username.trim()) return this.error(connection, 'bad_username', 'username required');
    if (this.hostId()) return this.error(connection, 'room_taken', 'room already has a host');
    const member = this.addMember(username, connection);
    this.setHost(member.userId);
    this.send(connection, S2C.ROOM_CREATED, {
      room_code: this.code,
      user_id: member.userId,
      session_token: member.sessionToken,
      state: this.snapshot(),
    });
  }

  private async join(connection: Connection, username: unknown): Promise<void> {
    if (typeof username !== 'string' || !username.trim()) return this.error(connection, 'bad_username', 'username required');
    if (this.members.size + this.pending.size >= MAX_MEMBERS) {
      return this.send(connection, S2C.JOIN_REJECTED, { reason: 'Room is full' });
    }
    const userId = randomUUID();
    const pending: PendingJoin = {
      userId,
      username: username.trim().slice(0, 120),
      sessionToken: randomUUID(),
      connection,
    };
    connection.pendingId = userId;
    this.pending.set(userId, pending);
    const host = this.hostId();
    if (!host) return this.approveJoin(userId);
    for (const candidate of this.connections) {
      if (candidate.userId === host) this.send(candidate, S2C.JOIN_REQUEST, { user_id: userId, username: pending.username });
    }
  }

  private addMember(username: string, connection: Connection, existing?: Member): Member {
    const member = existing ?? {
      userId: randomUUID(),
      username: username.trim().slice(0, 120),
      sessionToken: randomUUID(),
      joinedAt: Date.now(),
    };
    member.connection = connection;
    connection.userId = member.userId;
    connection.pendingId = undefined;
    this.members.set(member.userId, member);
    this.tokens.set(member.sessionToken, member.userId);
    return member;
  }

  private async approveJoin(userId: string): Promise<void> {
    const request = this.pending.get(userId);
    if (!request) return;
    this.pending.delete(userId);
    this.addMember(request.username, request.connection, {
      userId: request.userId,
      username: request.username,
      sessionToken: request.sessionToken,
      joinedAt: Date.now(),
      connection: request.connection,
    });
    this.send(request.connection, S2C.JOIN_APPROVED, {
      room_code: this.code,
      user_id: request.userId,
      session_token: request.sessionToken,
      state: this.snapshot(),
    });
    this.broadcast(S2C.USER_JOINED, { user_id: request.userId, username: request.username }, request.userId);
  }

  private async rejectJoin(userId: string, reason: unknown): Promise<void> {
    const request = this.pending.get(userId);
    if (!request) return;
    this.pending.delete(userId);
    request.connection.pendingId = undefined;
    this.send(request.connection, S2C.JOIN_REJECTED, {
      reason: typeof reason === 'string' && reason.trim() ? reason.slice(0, 300) : 'Rejected by host',
    });
  }

  private async reconnect(connection: Connection, token: unknown): Promise<void> {
    const userId = typeof token === 'string' ? this.tokens.get(token) : undefined;
    const member = userId ? this.members.get(userId) : undefined;
    if (!member || !userId) return this.send(connection, S2C.JOIN_REJECTED, { reason: 'Session expired' });
    if (member.connection && member.connection !== connection) {
      member.connection.ws.close(1000, 'replaced');
      this.connections.delete(member.connection);
    }
    if (this.isHost(userId)) {
      if (this.hostGraceTimer) clearTimeout(this.hostGraceTimer);
      this.hostGraceTimer = undefined;
    }
    this.addMember(member.username, connection, member);
    this.send(connection, S2C.RECONNECTED, {
      room_code: this.code,
      user_id: userId,
      state: this.snapshot(),
      is_host: this.isHost(userId),
    });
    this.broadcast(S2C.USER_RECONNECTED, { user_id: userId, username: member.username }, userId);
  }

  private async playback(fromUserId: string, payload: Record<string, any>): Promise<void> {
    const action = typeof payload.action === 'string' ? payload.action : '';
    const position = finiteNumber(payload.position) ? Math.max(0, payload.position) : undefined;
    switch (action) {
      case 'play':
        this.isPlaying = true;
        if (position !== undefined) this.position = position;
        break;
      case 'pause':
        this.isPlaying = false;
        if (position !== undefined) this.position = position;
        break;
      case 'seek':
        if (position === undefined) return this.errorForUser(fromUserId, 'bad_position', 'position must be a number');
        this.position = position;
        break;
      case 'set_volume':
        if (!finiteNumber(payload.volume)) return this.errorForUser(fromUserId, 'bad_volume', 'volume must be a number');
        this.volume = Math.min(1, Math.max(0, payload.volume));
        break;
      case 'change_track':
      case 'skip_next':
      case 'skip_prev': {
        const track = normalizeTrack(payload.track_info);
        if (track) this.currentTrack = track;
        if (action === 'change_track' && !track) return this.errorForUser(fromUserId, 'bad_track', 'track_info is required');
        this.isPlaying = false;
        this.position = position ?? 0;
        break;
      }
      case 'queue_add': {
        const track = normalizeTrack(payload.track_info);
        if (!track) return this.errorForUser(fromUserId, 'bad_track', 'track_info is required');
        this.queue = payload.insert_next === true ? [track, ...this.queue] : [...this.queue, track];
        break;
      }
      case 'queue_remove':
        if (typeof payload.track_id !== 'string' || !payload.track_id) return this.errorForUser(fromUserId, 'bad_track', 'track_id is required');
        this.queue = this.queue.filter((track) => track.id !== payload.track_id);
        break;
      case 'queue_clear':
        this.queue = [];
        break;
      case 'sync_queue':
        if (!Array.isArray(payload.queue)) return this.errorForUser(fromUserId, 'bad_queue', 'queue must be an array');
        this.queue = payload.queue.map(normalizeTrack).filter((track): track is TrackInfo => track !== null).slice(0, 500);
        break;
      default:
        return this.errorForUser(fromUserId, 'bad_action', `unsupported playback action: ${action || 'missing'}`);
    }
    this.lastUpdate = Date.now();
    this.broadcast(S2C.SYNC_PLAYBACK, { ...payload, server_time: this.lastUpdate, from_user_id: fromUserId });
    if (action === 'change_track' && this.currentTrack) this.openBufferWindow(this.currentTrack.id, fromUserId);
  }

  private errorForUser(userId: string, code: string, text: string): void {
    const member = this.members.get(userId);
    if (member?.connection) this.error(member.connection, code, text);
  }

  private syncPayload(): Record<string, unknown> {
    return {
      current_track: this.currentTrack,
      is_playing: this.isPlaying,
      position: this.position,
      last_update: this.lastUpdate,
      queue: this.queue,
      volume: this.volume,
      control_mode: this.controlMode,
      expires_at: this.expiresAt,
    };
  }

  private openBufferWindow(trackId: string, actorId: string): void {
    if (this.buffer) clearTimeout(this.buffer.timer);
    const waitingFor = new Set(
      Array.from(this.members.values())
        .filter((member) => member.connection && member.userId !== actorId)
        .map((member) => member.userId),
    );
    if (waitingFor.size === 0) {
      this.buffer = undefined;
      this.broadcast(S2C.BUFFER_COMPLETE, { track_id: trackId });
      return;
    }
    const timer = setTimeout(() => {
      if (!this.buffer || this.buffer.trackId !== trackId) return;
      this.buffer = undefined;
      this.broadcast(S2C.BUFFER_COMPLETE, { track_id: trackId });
    }, BUFFER_TIMEOUT_MS);
    this.buffer = { trackId, waitingFor, timer };
    this.broadcast(S2C.BUFFER_WAIT, { track_id: trackId, waiting_for: [...waitingFor] });
  }

  private bufferReady(userId: string, trackId: unknown): void {
    if (!this.buffer || typeof trackId !== 'string' || this.buffer.trackId !== trackId) return;
    this.buffer.waitingFor.delete(userId);
    if (this.buffer.waitingFor.size > 0) return;
    clearTimeout(this.buffer.timer);
    this.buffer = undefined;
    this.broadcast(S2C.BUFFER_COMPLETE, { track_id: trackId });
  }

  private chat(userId: string, payload: Record<string, any>): void {
    const text = typeof payload.message === 'string' ? payload.message.trim().slice(0, 2000) : '';
    if (!text) return this.errorForUser(userId, 'bad_message', 'message is required');
    const member = this.members.get(userId);
    if (!member) return;
    this.broadcast(S2C.CHAT, {
      user_id: userId,
      username: member.username,
      message: text,
      timestamp: Date.now(),
      reply_to: isRecord(payload.reply_to) ? payload.reply_to : null,
    });
  }

  private suggest(fromUserId: string, rawTrack: unknown): void {
    const track = normalizeTrack(rawTrack);
    const from = this.members.get(fromUserId);
    if (!track || !from) return this.errorForUser(fromUserId, 'bad_track', 'valid track_info is required');
    const suggestion: Suggestion = {
      suggestionId: randomUUID(),
      fromUserId,
      fromUsername: from.username,
      trackInfo: { ...track, suggested_by: from.username },
    };
    this.suggestions.set(suggestion.suggestionId, suggestion);
    const host = this.hostId();
    const hostMember = host ? this.members.get(host) : undefined;
    if (hostMember?.connection) {
      this.send(hostMember.connection, S2C.SUGGESTION_RECEIVED, {
        suggestion_id: suggestion.suggestionId,
        from_user_id: fromUserId,
        from_username: from.username,
        track_info: suggestion.trackInfo,
      });
    }
  }

  private resolveSuggestion(id: unknown, approved: boolean, reason: unknown): void {
    if (typeof id !== 'string') return;
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return;
    this.suggestions.delete(id);
    if (approved) {
      this.queue = [suggestion.trackInfo, ...this.queue];
      this.broadcast(S2C.SUGGESTION_APPROVED, {
        suggestion_id: id,
        track_info: suggestion.trackInfo,
      });
    } else {
      const member = this.members.get(suggestion.fromUserId);
      if (member?.connection) {
        this.send(member.connection, S2C.SUGGESTION_REJECTED, {
          suggestion_id: id,
          reason: typeof reason === 'string' ? reason : null,
        });
      }
    }
  }

  private transferHost(userId: unknown): void {
    if (typeof userId !== 'string') return;
    const target = this.members.get(userId);
    if (!target?.connection) {
      const current = this.hostId();
      const member = current ? this.members.get(current) : undefined;
      if (member?.connection) this.error(member.connection, 'bad_target', 'user not connected');
      return;
    }
    this.setHost(userId);
    if (this.hostGraceTimer) clearTimeout(this.hostGraceTimer);
    this.hostGraceTimer = undefined;
    this.broadcast(S2C.HOST_CHANGED, { new_host_id: userId, new_host_name: target.username });
  }

  private kick(userId: unknown, reason: unknown): void {
    if (typeof userId !== 'string') return;
    const member = this.members.get(userId);
    if (!member) return;
    const text = typeof reason === 'string' && reason.trim() ? reason.slice(0, 300) : 'Removed by host';
    if (member.connection) {
      this.send(member.connection, S2C.KICKED, { reason: text });
      member.connection.ws.close(1000, 'kicked');
    }
    void this.remove(userId, 'kicked');
  }

  private async remove(userId: string, why: 'left' | 'kicked'): Promise<void> {
    const member = this.members.get(userId);
    if (!member) return;
    const wasHost = this.isHost(userId);
    this.members.delete(userId);
    this.tokens.delete(member.sessionToken);
    if (member.connection) {
      member.connection.userId = undefined;
      member.connection.pendingId = undefined;
    }
    this.broadcast(S2C.USER_LEFT, { user_id: userId, username: member.username });
    if (wasHost) this.promoteHost();
    if (this.members.size === 0 && this.pending.size === 0) this.expire(true);
  }

  private promoteHost(): void {
    const next = Array.from(this.members.values())
      .filter((member) => member.connection)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    this.setHost(next?.userId);
    if (next) this.broadcast(S2C.HOST_CHANGED, { new_host_id: next.userId, new_host_name: next.username });
  }

  private onClose(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    if (connection.pendingId) this.pending.delete(connection.pendingId);
    if (!connection.userId) return;
    const member = this.members.get(connection.userId);
    if (!member || member.connection !== connection) return;
    member.connection = undefined;
    this.broadcast(S2C.USER_DISCONNECTED, { user_id: member.userId, username: member.username });
    if (this.isHost(member.userId)) {
      if (this.hostGraceTimer) clearTimeout(this.hostGraceTimer);
      this.hostGraceTimer = setTimeout(() => {
        if (this.isHost(member.userId) && !this.members.get(member.userId)?.connection) this.promoteHost();
      }, HOST_GRACE_MS);
    }
  }

  private warnOfExpiry(): void {
    if (this.warned) return;
    this.warned = true;
    this.broadcast(S2C.ROOM_EXPIRING, {
      expires_at: this.expiresAt,
      extensions_left: Math.max(0, MAX_EXTENSIONS - this.extensionsUsed),
    });
  }

  private resetTimers(): void {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.warningTimer);
    const untilExpiry = Math.max(0, this.expiresAt - Date.now());
    this.expiryTimer = setTimeout(() => this.expire(), untilExpiry);
    this.warningTimer = setTimeout(() => this.warnOfExpiry(), Math.max(0, untilExpiry - EXPIRY_WARNING_MS));
  }

  private expire(immediate = false): void {
    if (!immediate && Date.now() < this.expiresAt) return this.resetTimers();
    this.broadcast(S2C.ROOM_CLOSED, { reason: immediate ? 'Session ended' : 'Room expired' });
    for (const connection of this.connections) connection.ws.close(1000, 'room expired');
    if (this.buffer) clearTimeout(this.buffer.timer);
    if (this.hostGraceTimer) clearTimeout(this.hostGraceTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.warningTimer);
    this.onExpired(this);
  }
}

class BlendStore {
  private readonly blends = new Map<string, Blend>();

  create(username: string): Blend {
    let code = generateCode();
    while (this.blends.has(code)) code = generateCode();
    const blend: Blend = { code, createdAt: Date.now(), members: new Map([[username, Date.now()]]), tracks: new Map() };
    this.blends.set(code, blend);
    return blend;
  }

  get(code: string): Blend | undefined {
    return this.blends.get(code.toUpperCase());
  }

  join(code: string, username: string): Blend | undefined {
    const blend = this.get(code);
    if (!blend) return undefined;
    blend.members.set(username, Date.now());
    return blend;
  }

  addTrack(code: string, username: string, rawTrack: unknown): Blend | undefined {
    const blend = this.get(code);
    if (!blend || !blend.members.has(username)) return undefined;
    const track = normalizeTrack(rawTrack);
    if (!track) return undefined;
    const existing = blend.tracks.get(track.id);
    if (existing) {
      existing.participants.add(username);
    } else {
      blend.tracks.set(track.id, { track, participants: new Set([username]) });
    }
    return blend;
  }

  snapshot(blend: Blend): Record<string, unknown> {
    const tracks = [...blend.tracks.values()]
      .sort((a, b) => b.participants.size - a.participants.size || a.track.title.localeCompare(b.track.title))
      .map(({ track, participants }) => ({
        ...track,
        score: participants.size,
        submitted_by: [...participants],
      }));
    return {
      code: blend.code,
      blend_code: blend.code,
      created_at: blend.createdAt,
      members: [...blend.members.keys()],
      tracks,
    };
  }
}

const rooms = new Map<string, Room>();
const blends = new BlendStore();

async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'OPTIONS') return writeJson(response, { ok: true });
  if (url.pathname === '/health' && request.method === 'GET') return writeJson(response, { ok: true });
  if (url.pathname === '/test' && request.method === 'GET') {
    if (!authorized(request)) return writeJson(response, { error: 'unauthorized' }, 401);
    return writeText(response, TEST_CLIENT_HTML, 200, 'text/html');
  }
  if (!authorized(request)) return writeJson(response, { error: 'unauthorized' }, 401);

  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    rooms.set(code, new Room(code, (room) => rooms.delete(room.code)));
    return writeJson(response, { room_code: code });
  }

  const blendCreate = url.pathname === '/api/blends' && request.method === 'POST';
  if (blendCreate) {
    try {
      const body = await readJson(request);
      const username = typeof body.username === 'string' ? body.username.trim().slice(0, 120) : '';
      if (!username) return writeJson(response, { error: 'username_required' }, 400);
      return writeJson(response, blends.snapshot(blends.create(username)), 201);
    } catch (error) {
      return writeJson(response, { error: 'invalid_json', detail: String(error) }, 400);
    }
  }

  const joinMatch = url.pathname.match(/^\/api\/blends\/([A-Z0-9]{4,12})\/join$/i);
  if (joinMatch && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const username = typeof body.username === 'string' ? body.username.trim().slice(0, 120) : '';
      const blend = username ? blends.join(joinMatch[1], username) : undefined;
      if (!blend) return writeJson(response, { error: 'blend_not_found_or_invalid_username' }, 404);
      return writeJson(response, blends.snapshot(blend));
    } catch (error) {
      return writeJson(response, { error: 'invalid_json', detail: String(error) }, 400);
    }
  }

  const trackMatch = url.pathname.match(/^\/api\/blends\/([A-Z0-9]{4,12})\/tracks$/i);
  if (trackMatch && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const username = typeof body.username === 'string' ? body.username.trim().slice(0, 120) : '';
      const blend = username ? blends.addTrack(trackMatch[1], username, body.track) : undefined;
      if (!blend) return writeJson(response, { error: 'blend_not_found_or_invalid_track' }, 404);
      return writeJson(response, blends.snapshot(blend));
    } catch (error) {
      return writeJson(response, { error: 'invalid_json', detail: String(error) }, 400);
    }
  }

  const blendMatch = url.pathname.match(/^\/api\/blends\/([A-Z0-9]{4,12})$/i);
  if (blendMatch && request.method === 'GET') {
    const blend = blends.get(blendMatch[1]);
    return blend ? writeJson(response, blends.snapshot(blend)) : writeJson(response, { error: 'blend_not_found' }, 404);
  }

  if (url.pathname.startsWith('/room/')) {
    return writeJson(response, { error: 'websocket_upgrade_required' }, 426);
  }
  return writeJson(response, { error: 'not_found', path: url.pathname }, 404);
}

const httpServer = createServer((request, response) => {
  void handleHttp(request, response).catch((error) => {
    if (!response.headersSent) writeJson(response, { error: 'internal_error' }, 500);
    console.error('HTTP request failed:', error);
  });
});

const webSocketServer = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const match = url.pathname.match(/^\/room\/([A-Z0-9]{4,12})$/i);
  if (!match || !authorized(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const room = rooms.get(match[1].toUpperCase());
  if (!room) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (ws) => room.attach(ws));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const base = PUBLIC_URL.replace(/\/+$/, '');
  console.log(`Convx Sync listening on ${base}`);
  console.log(`HTTP API: ${base}/api/rooms`);
  console.log(`WebSocket: ${base.replace(/^http/, 'ws')}/room/<CODE>`);
  console.log(`Blends API: ${base}/api/blends`);
  if (API_KEY) console.log('API key protection: enabled');
});