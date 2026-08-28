package com.kliovo.printagent.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Green = Color(0xFF22C55E)
private val Ink = Color(0xFF1F2937)

private val scheme = lightColorScheme(
    primary = Green,
    onPrimary = Color.White,
    secondary = Ink,
    background = Color(0xFFF8FAFC),
    surface = Color.White,
    onSurface = Ink,
    error = Color(0xFFDC2626),
)

@Composable
fun KliovoTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
