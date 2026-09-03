package com.convx.music.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import com.convx.music.ui.utils.bounceClick
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

import coil3.compose.AsyncImage
import com.music.innertube.utils.parseCookieString
import com.convx.music.R
import com.convx.music.constants.AccountEmailKey
import com.convx.music.constants.InnerTubeCookieKey
import com.convx.music.BuildConfig
import com.convx.music.utils.rememberPreference
import com.convx.music.viewmodels.HomeViewModel

@Composable
fun SettingDialoge(
    onDismissRequest: () -> Unit,
    onNavigate: (String) -> Unit,
    homeViewModel: HomeViewModel
) {
    val (innerTubeCookie, _) = rememberPreference(InnerTubeCookieKey, "")
    val isLoggedIn = remember(innerTubeCookie) {
        innerTubeCookie.isNotEmpty() && "SAPISID" in parseCookieString(innerTubeCookie)
    }

    val (accountEmail, _) = rememberPreference(AccountEmailKey, "")
    val accountName by homeViewModel.accountName.collectAsState()
    val accountImageUrl by homeViewModel.accountImageUrl.collectAsState()

    Dialog(
        onDismissRequest = onDismissRequest,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        val primaryColor = MaterialTheme.colorScheme.surface
        val onPrimaryColor = MaterialTheme.colorScheme.onSurface
        val secondaryColor = MaterialTheme.colorScheme.secondaryContainer
        val onSecondaryColor = MaterialTheme.colorScheme.onSecondaryContainer

        Surface(
            modifier = Modifier
                .padding(24.dp)
                .fillMaxWidth(),
            shape = RoundedCornerShape(28.dp),
            color = primaryColor,
            tonalElevation = 8.dp
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically)
            ) {
                // AppBar
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 4.dp, top = 10.dp, end = 4.dp, bottom = 10.dp)
                ) {
                    Image(
                        painter = painterResource(id = R.drawable.convx_logo),
                        contentDescription = "App Icon",
                        modifier = Modifier
                            .size(24.dp)
                            .clip(CircleShape)
                    )
                    
                    Text(
                        text = "MINIMALIST",
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.sp
                        ),
                        color = onPrimaryColor,
                    )

                    Image(
                        painter = painterResource(id = R.drawable.close),
                        contentDescription = "Cancel",
                        modifier = Modifier
                            .size(24.dp)
                            .bounceClick { onDismissRequest() },
                        colorFilter = ColorFilter.tint(onPrimaryColor)
                    )
                }

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(
                            RoundedCornerShape(
                                topStart = 25.dp,
                                topEnd = 25.dp,
                                bottomStart = 2.dp,
                                bottomEnd = 2.dp
                            )
                        )
                        .background(color = secondaryColor)
                        .bounceClick(enabled = isLoggedIn) {
                            onNavigate("settings/account")
                        }
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(15.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(15.dp, Alignment.Start)
                    ) {
                        if (isLoggedIn && !accountImageUrl.isNullOrBlank()) {
                            AsyncImage(
                                model = accountImageUrl,
                                contentDescription = "Profile Photo",
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .size(36.dp)
                                    .clip(CircleShape)
                            )
                        } else {
                            Icon(
                                painter = painterResource(R.drawable.account),
                                contentDescription = "Account Manager",
                                tint = onSecondaryColor,
                                modifier = Modifier
                                    .size(36.dp)
                                    .clip(CircleShape)
                            )
                        }
                        Column(
                            verticalArrangement = Arrangement.Top,
                            horizontalAlignment = Alignment.Start
                        ) {
                            Text(
                                text = if (isLoggedIn) accountName else "Anonymous",
                                fontWeight = FontWeight.Normal,
                                color = onSecondaryColor,
                                fontSize = 15.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                text = if (isLoggedIn) {
                                    accountEmail.ifEmpty { "Logged In" }
                                } else {
                                    "Not signed in"
                                },
                                fontWeight = FontWeight.Light,
                                color = onSecondaryColor,
                                fontSize = 14.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                    
                    OutlinedButton(
                        onClick = {
                            if (isLoggedIn) {
                                onNavigate("settings/account")
                            } else {
                                onNavigate("login")
                            }
                        },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.outlinedButtonColors(
                            containerColor = secondaryColor,
                            contentColor = onSecondaryColor
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = if (isLoggedIn) "Manage Account" else "Login",
                            color = onSecondaryColor,
                            fontWeight = FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }

                // Options List
                Column(
                    modifier = Modifier
                        .clip(
                            RoundedCornerShape(
                                topStart = 2.dp,
                                topEnd = 2.dp,
                                bottomStart = 25.dp,
                                bottomEnd = 25.dp
                            )
                        )
                        .background(color = secondaryColor)
                ) {
                    OptionItem(
                        option = Option("Minimalist", R.drawable.settings),
                        tintColor = onPrimaryColor,
                        textColor = onSecondaryColor,
                        onClick = { onNavigate("settings") }
                    )
                    OptionItem(
                        option = Option("About", R.drawable.info),
                        tintColor = onPrimaryColor,
                        textColor = onSecondaryColor,
                        trailingText = BuildConfig.VERSION_NAME,
                        onClick = { onNavigate("settings/about") },
                    )
                }
            }
        }
    }
}

private data class Option(
    val title: String,
    val icon: Int
)

@Composable
private fun OptionItem(
    option: Option,
    tintColor: Color,
    textColor: Color,
    trailingText: String? = null,
    onClick: (() -> Unit)? = null
) {
    val modifier = Modifier
        .fillMaxWidth()
        .then(if (onClick != null) Modifier.bounceClick { onClick() } else Modifier)
        .padding(12.dp)

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.Start)
    ) {
        Icon(
            painter = painterResource(id = option.icon),
            contentDescription = option.title,
            tint = tintColor,
            modifier = Modifier
                .padding(horizontal = 10.dp)
                .size(23.dp)
        )
        Text(
            modifier = Modifier.weight(1f),
            text = option.title,
            color = textColor,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        if (trailingText != null) {
            Text(
                text = trailingText,
                color = textColor.copy(alpha = 0.6f),
                fontSize = 14.sp,
                fontWeight = FontWeight.Light,
                modifier = Modifier.padding(end = 10.dp)
            )
        }
    }
}
