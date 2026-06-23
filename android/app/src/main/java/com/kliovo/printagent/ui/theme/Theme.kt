package com.kliovo.printagent.ui.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val KliovoGreen = Color(0xFF22C55E)
val KliovoGreenDark = Color(0xFF16A34A)
val KliovoDark = Color(0xFF1F2937)
val KliovoBg = Color(0xFFF6F8FA)
val KliovoBorder = Color(0xFFE2E8F0)
val KliovoMuted = Color(0xFF64748B)
val KliovoYellow = Color(0xFFEAB308)
val KliovoRed = Color(0xFFEF4444)
val KliovoWhite = Color(0xFFFFFFFF)

private val LightColors = lightColorScheme(
    primary = KliovoGreen,
    onPrimary = KliovoWhite,
    primaryContainer = KliovoGreen,
    secondary = KliovoDark,
    background = KliovoBg,
    surface = KliovoWhite,
    onSurface = KliovoDark,
    outline = KliovoBorder,
    error = KliovoRed
)

@Composable
fun KliovoPrintAgentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColors,
        content = content
    )
}
