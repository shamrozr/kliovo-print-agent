# Kliovo Print Agent — Android Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Android APK that mirrors the Electron desktop print agent — runs a local HTTP bridge on 127.0.0.1:6310 so Chrome on the same device can send ESC/POS print jobs to network thermal printers.

**Architecture:** Android ForegroundService hosts a NanoHTTPD server on port 6310 with the same API contract as the Electron agent (/ping, /print, /render-print, /status). TCP socket sender delivers raw ESC/POS bytes to printers on port 9100. Jetpack Compose settings UI for printer configuration.

**Tech Stack:** Kotlin, NanoHTTPD, Jetpack Compose (Material 3), SharedPreferences, Gson, Android ForegroundService.

---

## File Map

```
android/
├── app/
│   ├── build.gradle.kts
│   ├── src/main/
│   │   ├── AndroidManifest.xml
│   │   ├── res/
│   │   │   ├── drawable/ic_notification.xml
│   │   │   ├── drawable/ic_launcher_foreground.xml
│   │   │   ├── mipmap-anydpi-v26/ic_launcher.xml
│   │   │   ├── values/colors.xml
│   │   │   ├── values/strings.xml
│   │   │   ├── values/themes.xml
│   │   │   └── xml/network_security_config.xml
│   │   └── java/com/kliovo/printagent/
│   │       ├── KliovoPrintApp.kt
│   │       ├── config/
│   │       │   ├── PrinterEntry.kt
│   │       │   └── ConfigStore.kt
│   │       ├── health/
│   │       │   └── HealthTracker.kt
│   │       ├── printer/
│   │       │   └── TcpPrinterSender.kt
│   │       ├── escpos/
│   │       │   ├── CP1256.kt
│   │       │   ├── ESCPOSBuilder.kt
│   │       │   └── FormatPaisa.kt
│   │       ├── render/
│   │       │   ├── PrintJobData.kt
│   │       │   ├── ReceiptRenderer.kt
│   │       │   ├── KotRenderer.kt
│   │       │   ├── MasterKotRenderer.kt
│   │       │   ├── VoidKotRenderer.kt
│   │       │   └── LabelRenderer.kt
│   │       ├── bridge/
│   │       │   ├── IdempotencyGuard.kt
│   │       │   └── BridgeServer.kt
│   │       ├── service/
│   │       │   ├── PrintBridgeService.kt
│   │       │   └── BootReceiver.kt
│   │       └── ui/
│   │           ├── MainActivity.kt
│   │           └── theme/
│   │               └── Theme.kt
│   └── src/test/java/com/kliovo/printagent/
│       ├── escpos/ESCPOSBuilderTest.kt
│       ├── escpos/CP1256Test.kt
│       ├── escpos/FormatPaisaTest.kt
│       ├── render/ReceiptRendererTest.kt
│       ├── render/KotRendererTest.kt
│       ├── render/LabelRendererTest.kt
│       ├── bridge/IdempotencyGuardTest.kt
│       ├── health/HealthTrackerTest.kt
│       └── config/PrinterEntryTest.kt
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
└── gradle/
    └── libs.versions.toml
```

---

### Task 1: Scaffold Android project with Gradle

**Files:**
- Create: `android/settings.gradle.kts`
- Create: `android/build.gradle.kts`
- Create: `android/gradle.properties`
- Create: `android/gradle/libs.versions.toml`
- Create: `android/app/build.gradle.kts`
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/res/values/strings.xml`
- Create: `android/app/src/main/res/values/colors.xml`
- Create: `android/app/src/main/res/values/themes.xml`
- Create: `android/app/src/main/res/xml/network_security_config.xml`
- Create: `android/app/src/main/res/drawable/ic_notification.xml`
- Create: `android/app/src/main/res/drawable/ic_launcher_foreground.xml`
- Create: `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- Create: `android/app/src/main/java/com/kliovo/printagent/KliovoPrintApp.kt`

- [ ] **Step 1: Create version catalog**

```toml
# android/gradle/libs.versions.toml
[versions]
agp = "8.5.1"
kotlin = "2.0.0"
compose-bom = "2024.06.00"
nanohttpd = "2.3.1"
gson = "2.11.0"
junit = "4.13.2"

[libraries]
nanohttpd = { module = "org.nanohttpd:nanohttpd", version.ref = "nanohttpd" }
gson = { module = "com.google.code.gson:gson", version.ref = "gson" }
compose-bom = { module = "androidx.compose:compose-bom", version.ref = "compose-bom" }
compose-material3 = { module = "androidx.compose.material3:material3" }
compose-ui = { module = "androidx.compose.ui:ui" }
compose-ui-tooling = { module = "androidx.compose.ui:ui-tooling" }
compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
compose-activity = { module = "androidx.activity:activity-compose", version = "1.9.0" }
compose-navigation = { module = "androidx.navigation:navigation-compose", version = "2.7.7" }
lifecycle-runtime = { module = "androidx.lifecycle:lifecycle-runtime-compose", version = "2.8.2" }
core-ktx = { module = "androidx.core:core-ktx", version = "1.13.1" }
junit = { module = "junit:junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
compose-compiler = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
```

- [ ] **Step 2: Create root build.gradle.kts**

```kotlin
// android/build.gradle.kts
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.compose.compiler) apply false
}
```

- [ ] **Step 3: Create settings.gradle.kts**

```kotlin
// android/settings.gradle.kts
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolution {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "kliovo-print-agent"
include(":app")
```

- [ ] **Step 4: Create gradle.properties**

```properties
# android/gradle.properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
```

- [ ] **Step 5: Create app/build.gradle.kts**

```kotlin
// android/app/build.gradle.kts
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "com.kliovo.printagent"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kliovo.printagent"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.compose.activity)
    implementation(libs.compose.navigation)
    implementation(libs.lifecycle.runtime)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.nanohttpd)
    implementation(libs.gson)
    testImplementation(libs.junit)
}
```

- [ ] **Step 6: Create AndroidManifest.xml**

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <application
        android:name=".KliovoPrintApp"
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.KliovoPrintAgent"
        android:networkSecurityConfig="@xml/network_security_config"
        android:usesCleartextTraffic="true">

        <activity
            android:name=".ui.MainActivity"
            android:exported="true"
            android:theme="@style/Theme.KliovoPrintAgent">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service
            android:name=".service.PrintBridgeService"
            android:exported="false"
            android:foregroundServiceType="specialUse" />

        <receiver
            android:name=".service.BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    </application>
</manifest>
```

- [ ] **Step 7: Create resource files**

```xml
<!-- android/app/src/main/res/values/strings.xml -->
<resources>
    <string name="app_name">Kliovo Print Agent</string>
    <string name="notification_channel_name">Print Bridge Service</string>
    <string name="notification_channel_desc">Keeps the print bridge server running</string>
</resources>
```

```xml
<!-- android/app/src/main/res/values/colors.xml -->
<resources>
    <color name="kliovo_green">#FF22C55E</color>
    <color name="kliovo_green_dark">#FF16A34A</color>
    <color name="kliovo_dark">#FF1F2937</color>
    <color name="kliovo_bg">#FFF6F8FA</color>
    <color name="kliovo_yellow">#FFEAB308</color>
    <color name="kliovo_red">#FFEF4444</color>
    <color name="kliovo_border">#FFE2E8F0</color>
    <color name="kliovo_muted">#FF64748B</color>
</resources>
```

```xml
<!-- android/app/src/main/res/values/themes.xml -->
<resources>
    <style name="Theme.KliovoPrintAgent" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:statusBarColor">@color/kliovo_green</item>
        <item name="android:navigationBarColor">@android:color/white</item>
    </style>
</resources>
```

```xml
<!-- android/app/src/main/res/xml/network_security_config.xml -->
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
```

- [ ] **Step 8: Create drawable resources**

```xml
<!-- android/app/src/main/res/drawable/ic_notification.xml -->
<!-- Simple printer icon for the notification -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="#22C55E">
    <path
        android:fillColor="@android:color/white"
        android:pathData="M19,8H5c-1.66,0 -3,1.34 -3,3v6h4v4h12v-4h4v-6c0,-1.66 -1.34,-3 -3,-3zM16,19H8v-5h8v5zM19,12c-0.55,0 -1,-0.45 -1,-1s0.45,-1 1,-1 1,0.45 1,1 -0.45,1 -1,1zM18,3H6v4h12V3z" />
</vector>
```

```xml
<!-- android/app/src/main/res/drawable/ic_launcher_foreground.xml -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#22C55E"
        android:pathData="M54,30 L54,78 M30,54 L78,54"
        android:strokeWidth="8"
        android:strokeColor="#22C55E" />
    <path
        android:fillColor="#22C55E"
        android:pathData="M37,42 L71,42 L71,72 L37,72 Z" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M42,50 L66,50 M42,56 L66,56 M42,62 L58,62" 
        android:strokeWidth="2"
        android:strokeColor="#FFFFFF" />
</vector>
```

```xml
<!-- android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml -->
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@android:color/white" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
```

- [ ] **Step 9: Create KliovoPrintApp.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/KliovoPrintApp.kt
package com.kliovo.printagent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class KliovoPrintApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notification_channel_desc)
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "print_bridge_service"
    }
}
```

- [ ] **Step 10: Verify project builds**

Run from `android/` directory:
```bash
./gradlew assembleDebug
```
Expected: BUILD SUCCESSFUL (APK generated at `app/build/outputs/apk/debug/app-debug.apk`)

- [ ] **Step 11: Commit**

```bash
git add android/
git commit -m "feat(android): scaffold Kotlin project with Gradle, Compose, NanoHTTPD"
```

---

### Task 2: Config layer — PrinterEntry + ConfigStore

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/config/PrinterEntry.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/config/ConfigStore.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/config/PrinterEntryTest.kt`

- [ ] **Step 1: Write the test**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/config/PrinterEntryTest.kt
package com.kliovo.printagent.config

import com.google.gson.Gson
import org.junit.Assert.*
import org.junit.Test

class PrinterEntryTest {

    private val gson = Gson()

    @Test
    fun `serialize and deserialize PrinterEntry`() {
        val entry = PrinterEntry(
            printerId = "printer-1",
            agentKey = "ak_123",
            host = "192.168.1.100",
            port = 9100,
            name = "Kitchen",
            paperWidth = 80
        )
        val json = gson.toJson(entry)
        val restored = gson.fromJson(json, PrinterEntry::class.java)
        assertEquals(entry.printerId, restored.printerId)
        assertEquals(entry.host, restored.host)
        assertEquals(entry.port, restored.port)
        assertEquals(entry.paperWidth, restored.paperWidth)
    }

    @Test
    fun `default port is 9100`() {
        val entry = PrinterEntry(
            printerId = "p1",
            agentKey = "ak",
            host = "10.0.0.1",
            name = "Test"
        )
        assertEquals(9100, entry.port)
        assertEquals(80, entry.paperWidth)
    }

    @Test
    fun `AgentConfig defaults`() {
        val config = AgentConfig()
        assertEquals("https://dine.kliovo.com", config.serverUrl)
        assertTrue(config.printers.isEmpty())
    }
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.config.PrinterEntryTest"
```
Expected: FAIL — class not found.

- [ ] **Step 3: Implement PrinterEntry.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/config/PrinterEntry.kt
package com.kliovo.printagent.config

data class PrinterEntry(
    val printerId: String,
    val agentKey: String = "",
    val host: String = "",
    val port: Int = 9100,
    val name: String = "",
    val paperWidth: Int = 80
)

data class AgentConfig(
    val serverUrl: String = "https://dine.kliovo.com",
    val printers: List<PrinterEntry> = emptyList()
)
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.config.PrinterEntryTest"
```
Expected: 3 tests PASS.

- [ ] **Step 5: Implement ConfigStore.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/config/ConfigStore.kt
package com.kliovo.printagent.config

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson

class ConfigStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("agent_config", Context.MODE_PRIVATE)
    private val gson = Gson()

    fun load(): AgentConfig {
        val json = prefs.getString(KEY_CONFIG, null) ?: return AgentConfig()
        return try {
            gson.fromJson(json, AgentConfig::class.java) ?: AgentConfig()
        } catch (_: Exception) {
            AgentConfig()
        }
    }

    fun save(config: AgentConfig) {
        prefs.edit()
            .putString(KEY_CONFIG, gson.toJson(config))
            .apply()
    }

    companion object {
        private const val KEY_CONFIG = "config_json"
    }
}
```

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/config/ \
        android/app/src/test/java/com/kliovo/printagent/config/
git commit -m "feat(android): add PrinterEntry, AgentConfig, ConfigStore"
```

---

### Task 3: Health tracker — in-memory ring buffer

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/health/HealthTracker.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/health/HealthTrackerTest.kt`

- [ ] **Step 1: Write the test**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/health/HealthTrackerTest.kt
package com.kliovo.printagent.health

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class HealthTrackerTest {

    private lateinit var tracker: HealthTracker

    @Before
    fun setUp() {
        tracker = HealthTracker()
    }

    @Test
    fun `empty tracker returns green`() {
        val snap = tracker.snapshot()
        assertEquals("green", snap.status)
        assertTrue(snap.recent.isEmpty())
        assertTrue(snap.printers.isEmpty())
    }

    @Test
    fun `successful job recorded and visible in snapshot`() {
        tracker.record("p1", "Kitchen", "receipt", true, null)
        val snap = tracker.snapshot()
        assertEquals("green", snap.status)
        assertEquals(1, snap.recent.size)
        assertEquals("receipt", snap.recent[0].kind)
        assertTrue(snap.recent[0].ok)
    }

    @Test
    fun `failed job sets status to red`() {
        tracker.record("p1", "Kitchen", "receipt", false, "timeout")
        val snap = tracker.snapshot()
        assertEquals("red", snap.status)
        assertEquals(1, snap.printers.size)
        assertFalse(snap.printers[0].ok)
    }

    @Test
    fun `recovery after failure sets status to yellow within window`() {
        tracker.record("p1", "Kitchen", "receipt", false, "timeout")
        tracker.record("p1", "Kitchen", "receipt", true, null)
        val snap = tracker.snapshot()
        assertEquals("yellow", snap.status)
    }

    @Test
    fun `ring buffer caps at MAX_EVENTS`() {
        repeat(30) { i ->
            tracker.record("p1", "Kitchen", "receipt", true, null)
        }
        val snap = tracker.snapshot()
        assertEquals(25, snap.recent.size)
    }

    @Test
    fun `snapshot returns at most 10 recent events`() {
        repeat(20) {
            tracker.record("p1", "Kitchen", "receipt", true, null)
        }
        val snap = tracker.snapshot()
        assertEquals(10, snap.recent.size)
    }
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.health.HealthTrackerTest"
```
Expected: FAIL — class not found.

- [ ] **Step 3: Implement HealthTracker.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/health/HealthTracker.kt
package com.kliovo.printagent.health

data class JobEvent(
    val ts: Long,
    val printerId: String,
    val printerName: String,
    val kind: String,
    val ok: Boolean,
    val error: String?
)

data class PrinterStatus(val printerId: String, val ok: Boolean)

data class HealthSnapshot(
    val status: String,
    val printers: List<PrinterStatus>,
    val recent: List<JobEvent>
)

class HealthTracker {

    private val events = mutableListOf<JobEvent>()
    private val lastResultByPrinter = mutableMapOf<String, Boolean>()
    private val recentWindowMs = 5 * 60_000L

    fun record(
        printerId: String,
        printerName: String,
        kind: String,
        ok: Boolean,
        error: String?
    ) {
        val evt = JobEvent(
            ts = System.currentTimeMillis(),
            printerId = printerId,
            printerName = printerName,
            kind = kind,
            ok = ok,
            error = error
        )
        events.add(0, evt)
        if (events.size > MAX_EVENTS) {
            events.removeAt(events.lastIndex)
        }
        lastResultByPrinter[printerId] = ok
    }

    fun snapshot(): HealthSnapshot {
        return HealthSnapshot(
            status = computeStatus(),
            printers = lastResultByPrinter.map { (id, ok) -> PrinterStatus(id, ok) },
            recent = events.take(10)
        )
    }

    fun computeStatus(): String {
        val states = lastResultByPrinter.values
        if (states.any { !it }) return "red"
        val now = System.currentTimeMillis()
        val recentFailure = events.any { !it.ok && now - it.ts < recentWindowMs }
        if (recentFailure) return "yellow"
        return "green"
    }

    companion object {
        private const val MAX_EVENTS = 25
    }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.health.HealthTrackerTest"
```
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/health/ \
        android/app/src/test/java/com/kliovo/printagent/health/
git commit -m "feat(android): add HealthTracker with ring buffer and status computation"
```

---

### Task 4: TCP printer sender

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/printer/TcpPrinterSender.kt`

- [ ] **Step 1: Implement TcpPrinterSender.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/printer/TcpPrinterSender.kt
package com.kliovo.printagent.printer

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

object TcpPrinterSender {

    private const val TIMEOUT_MS = 5000

    fun send(host: String, port: Int, bytes: ByteArray) {
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), TIMEOUT_MS)
            socket.soTimeout = TIMEOUT_MS
            socket.getOutputStream().use { out ->
                out.write(bytes)
                out.flush()
            }
        } catch (e: IOException) {
            throw IOException("TCP send to $host:$port failed: ${e.message}", e)
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/printer/
git commit -m "feat(android): add TcpPrinterSender for network thermal printers"
```

---

### Task 5: ESC/POS builder — CP-1256, builder, formatPaisa

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/escpos/CP1256.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/escpos/ESCPOSBuilder.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/escpos/FormatPaisa.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/escpos/CP1256Test.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/escpos/ESCPOSBuilderTest.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/escpos/FormatPaisaTest.kt`

- [ ] **Step 1: Write CP1256 test**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/escpos/CP1256Test.kt
package com.kliovo.printagent.escpos

import org.junit.Assert.*
import org.junit.Test

class CP1256Test {

    @Test
    fun `ASCII maps to itself`() {
        val bytes = CP1256.encode("Hello")
        assertEquals(5, bytes.size)
        assertEquals('H'.code.toByte(), bytes[0])
        assertEquals('o'.code.toByte(), bytes[4])
    }

    @Test
    fun `unmapped Unicode falls back to question mark`() {
        val bytes = CP1256.encode("世") // CJK character — not in CP1256
        assertEquals(1, bytes.size)
        assertEquals(0x3F.toByte(), bytes[0]) // '?'
    }

    @Test
    fun `Urdu pe maps to 0x81`() {
        val bytes = CP1256.encode("پ") // پ
        assertEquals(1, bytes.size)
        assertEquals(0x81.toByte(), bytes[0])
    }

    @Test
    fun `Urdu ye maps to 0xFF`() {
        val bytes = CP1256.encode("ے") // ے
        assertEquals(1, bytes.size)
        assertEquals(0xFF.toByte(), bytes[0])
    }
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.escpos.CP1256Test"
```
Expected: FAIL.

- [ ] **Step 3: Implement CP1256.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/escpos/CP1256.kt
package com.kliovo.printagent.escpos

object CP1256 {

    const val CODE_PAGE: Int = 32

    private val lookup: Map<Int, Int> = buildMap {
        // Lower 0x00-0x7F identical to ASCII
        for (i in 0 until 0x80) put(i, i)
        // Upper bank: Unicode codepoint → CP-1256 byte
        val pairs = intArrayOf(
            0x20AC, 0x80, 0x067E, 0x81, 0x201A, 0x82, 0x0192, 0x83, 0x201E, 0x84,
            0x2026, 0x85, 0x2020, 0x86, 0x2021, 0x87, 0x02C6, 0x88, 0x2030, 0x89,
            0x0679, 0x8A, 0x2039, 0x8B, 0x0152, 0x8C, 0x0686, 0x8D, 0x0698, 0x8E,
            0x0688, 0x8F, 0x06AF, 0x90, 0x2018, 0x91, 0x2019, 0x92, 0x201C, 0x93,
            0x201D, 0x94, 0x2022, 0x95, 0x2013, 0x96, 0x2014, 0x97, 0x06A9, 0x98,
            0x2122, 0x99, 0x0691, 0x9A, 0x203A, 0x9B, 0x0153, 0x9C, 0x200C, 0x9D,
            0x200D, 0x9E, 0x06BA, 0x9F, 0x00A0, 0xA0, 0x060C, 0xA1, 0x00A2, 0xA2,
            0x00A3, 0xA3, 0x00A4, 0xA4, 0x00A5, 0xA5, 0x00A6, 0xA6, 0x00A7, 0xA7,
            0x00A8, 0xA8, 0x00A9, 0xA9, 0x06BE, 0xAA, 0x00AB, 0xAB, 0x00AC, 0xAC,
            0x00AD, 0xAD, 0x00AE, 0xAE, 0x00AF, 0xAF, 0x00B0, 0xB0, 0x00B1, 0xB1,
            0x00B2, 0xB2, 0x00B3, 0xB3, 0x00B4, 0xB4, 0x00B5, 0xB5, 0x00B6, 0xB6,
            0x00B7, 0xB7, 0x00B8, 0xB8, 0x00B9, 0xB9, 0x061B, 0xBA, 0x00BB, 0xBB,
            0x00BC, 0xBC, 0x00BD, 0xBD, 0x00BE, 0xBE, 0x061F, 0xBF, 0x06C1, 0xC0,
            0x0621, 0xC1, 0x0622, 0xC2, 0x0623, 0xC3, 0x0624, 0xC4, 0x0625, 0xC5,
            0x0626, 0xC6, 0x0627, 0xC7, 0x0628, 0xC8, 0x0629, 0xC9, 0x062A, 0xCA,
            0x062B, 0xCB, 0x062C, 0xCC, 0x062D, 0xCD, 0x062E, 0xCE, 0x062F, 0xCF,
            0x0630, 0xD0, 0x0631, 0xD1, 0x0632, 0xD2, 0x0633, 0xD3, 0x0634, 0xD4,
            0x0635, 0xD5, 0x0636, 0xD6, 0x00D7, 0xD7, 0x0637, 0xD8, 0x0638, 0xD9,
            0x0639, 0xDA, 0x063A, 0xDB, 0x0640, 0xDC, 0x0641, 0xDD, 0x0642, 0xDE,
            0x0643, 0xDF, 0x00E0, 0xE0, 0x0644, 0xE1, 0x00E2, 0xE2, 0x0645, 0xE3,
            0x0646, 0xE4, 0x0647, 0xE5, 0x0648, 0xE6, 0x00E7, 0xE7, 0x00E8, 0xE8,
            0x00E9, 0xE9, 0x00EA, 0xEA, 0x00EB, 0xEB, 0x0649, 0xEC, 0x064A, 0xED,
            0x00EE, 0xEE, 0x00EF, 0xEF, 0x064B, 0xF0, 0x064C, 0xF1, 0x064D, 0xF2,
            0x064E, 0xF3, 0x00F4, 0xF4, 0x064F, 0xF5, 0x0650, 0xF6, 0x00F7, 0xF7,
            0x0651, 0xF8, 0x00F9, 0xF9, 0x0652, 0xFA, 0x00FB, 0xFB, 0x00FC, 0xFC,
            0x200E, 0xFD, 0x200F, 0xFE, 0x06D2, 0xFF
        )
        var i = 0
        while (i < pairs.size) {
            put(pairs[i], pairs[i + 1])
            i += 2
        }
    }

    fun encode(s: String): ByteArray {
        val out = mutableListOf<Byte>()
        for (char in s) {
            val code = char.code
            val mapped = lookup[code]
            if (mapped != null) {
                out.add(mapped.toByte())
            } else if (code < 0x80) {
                out.add(code.toByte())
            } else {
                out.add(0x3F) // '?'
            }
        }
        return out.toByteArray()
    }
}
```

- [ ] **Step 4: Run CP1256 test — verify it passes**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.escpos.CP1256Test"
```
Expected: 4 tests PASS.

- [ ] **Step 5: Write FormatPaisa test**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/escpos/FormatPaisaTest.kt
package com.kliovo.printagent.escpos

import org.junit.Assert.*
import org.junit.Test

class FormatPaisaTest {

    @Test
    fun `whole rupee amount`() {
        assertEquals("Rs 1,234", FormatPaisa.format(123400))
    }

    @Test
    fun `zero amount`() {
        assertEquals("Rs 0", FormatPaisa.format(0))
    }

    @Test
    fun `fractional paisa`() {
        assertEquals("Rs 0.50", FormatPaisa.format(50))
    }

    @Test
    fun `large amount with commas`() {
        assertEquals("Rs 100,000", FormatPaisa.format(10000000))
    }
}
```

- [ ] **Step 6: Implement FormatPaisa.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/escpos/FormatPaisa.kt
package com.kliovo.printagent.escpos

import java.text.NumberFormat
import java.util.Locale

object FormatPaisa {

    private val wholeFormatter = NumberFormat.getIntegerInstance(Locale("en", "PK"))
    private val fracFormatter = NumberFormat.getInstance(Locale("en", "PK")).apply {
        minimumFractionDigits = 2
        maximumFractionDigits = 2
    }

    fun format(amountPaisa: Long): String {
        val rupees = amountPaisa / 100.0
        return if (amountPaisa % 100 == 0L) {
            "Rs ${wholeFormatter.format(amountPaisa / 100)}"
        } else {
            "Rs ${fracFormatter.format(rupees)}"
        }
    }
}
```

- [ ] **Step 7: Run FormatPaisa test — verify it passes**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.escpos.FormatPaisaTest"
```
Expected: 4 tests PASS.

- [ ] **Step 8: Write ESCPOSBuilder test**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/escpos/ESCPOSBuilderTest.kt
package com.kliovo.printagent.escpos

import org.junit.Assert.*
import org.junit.Test

class ESCPOSBuilderTest {

    @Test
    fun `init emits ESC @ then code page`() {
        val bytes = ESCPOSBuilder().init().build()
        // ESC @ = 0x1B 0x40, then ESC t 32 = 0x1B 0x74 0x20
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x40.toByte(), bytes[1])
        assertEquals(0x1B.toByte(), bytes[2])
        assertEquals(0x74.toByte(), bytes[3])
        assertEquals(CP1256.CODE_PAGE.toByte(), bytes[4])
    }

    @Test
    fun `text appends encoded bytes`() {
        val bytes = ESCPOSBuilder().init().text("Hi").build()
        val textStart = 5 // after init (5 bytes)
        assertEquals('H'.code.toByte(), bytes[textStart])
        assertEquals('i'.code.toByte(), bytes[textStart + 1])
    }

    @Test
    fun `align center emits ESC a 1`() {
        val bytes = ESCPOSBuilder().align("center").build()
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x61.toByte(), bytes[1])
        assertEquals(0x01.toByte(), bytes[2])
    }

    @Test
    fun `bold on emits ESC E 1`() {
        val bytes = ESCPOSBuilder().bold(true).build()
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x45.toByte(), bytes[1])
        assertEquals(0x01.toByte(), bytes[2])
    }

    @Test
    fun `cut emits feed then GS V`() {
        val bytes = ESCPOSBuilder().cut(true).build()
        // feed(1) = ESC d 1, cut = GS V 0x00
        assertEquals(0x1B.toByte(), bytes[0]) // ESC
        assertEquals(0x64.toByte(), bytes[1]) // d
        assertEquals(0x01.toByte(), bytes[2]) // 1
        assertEquals(0x1D.toByte(), bytes[3]) // GS
        assertEquals(0x56.toByte(), bytes[4]) // V
        assertEquals(0x00.toByte(), bytes[5]) // full cut
    }

    @Test
    fun `row pads with spaces to paper width`() {
        val bytes = ESCPOSBuilder().row("Total", "Rs 100", 80).build()
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.startsWith("Total"))
        assertTrue(text.endsWith("Rs 100\n"))
        // 48 chars total for 80mm paper + newline
        assertEquals(49, bytes.size) // 48 content + 1 LF
    }

    @Test
    fun `rule fills paper width`() {
        val bytes = ESCPOSBuilder().rule(80, "-").build()
        val text = String(bytes, Charsets.US_ASCII)
        assertEquals(48 + 1, text.length) // 48 dashes + newline
    }
}
```

- [ ] **Step 9: Implement ESCPOSBuilder.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/escpos/ESCPOSBuilder.kt
package com.kliovo.printagent.escpos

import java.io.ByteArrayOutputStream

class ESCPOSBuilder {

    private val out = ByteArrayOutputStream()
    private var currentCodePage = CP1256.CODE_PAGE

    // Control bytes
    private companion object {
        const val ESC: Byte = 0x1B
        const val GS: Byte = 0x1D
        const val LF: Byte = 0x0A
    }

    fun init(): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x40)) // ESC @
        return codePage(CP1256.CODE_PAGE)
    }

    fun codePage(cp: Int): ESCPOSBuilder {
        currentCodePage = cp
        out.write(byteArrayOf(ESC, 0x74, cp.toByte())) // ESC t n
        return this
    }

    fun text(s: String): ESCPOSBuilder {
        if (s.isEmpty()) return this
        out.write(encodeText(s))
        return this
    }

    fun line(s: String = ""): ESCPOSBuilder {
        return text(s).newline()
    }

    fun newline(count: Int = 1): ESCPOSBuilder {
        if (count <= 0) return this
        repeat(count) { out.write(LF.toInt()) }
        return this
    }

    fun feed(lines: Int): ESCPOSBuilder {
        if (lines <= 0) return this
        out.write(byteArrayOf(ESC, 0x64, lines.coerceAtMost(255).toByte()))
        return this
    }

    fun align(a: String): ESCPOSBuilder {
        val n: Byte = when (a) {
            "left" -> 0
            "center" -> 1
            "right" -> 2
            else -> 0
        }
        out.write(byteArrayOf(ESC, 0x61, n))
        return this
    }

    fun bold(on: Boolean): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x45, if (on) 1 else 0))
        return this
    }

    fun underline(level: Int = 1): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x2D, level.toByte()))
        return this
    }

    fun invert(on: Boolean): ESCPOSBuilder {
        out.write(byteArrayOf(GS, 0x42, if (on) 1 else 0))
        return this
    }

    fun size(size: String): ESCPOSBuilder {
        val n: Byte = when (size) {
            "small" -> 0x00
            "normal" -> 0x00
            "large" -> 0x11
            "xlarge" -> 0x22
            else -> 0x00
        }
        out.write(byteArrayOf(GS, 0x21, n)) // GS ! n
        // Font B for "small"
        out.write(byteArrayOf(ESC, 0x4D, if (size == "small") 0x01 else 0x00))
        return this
    }

    fun rule(paperWidth: Int = 80, char: String = "-"): ESCPOSBuilder {
        val width = if (paperWidth == 80) 48 else 32
        return line(char.repeat(width))
    }

    fun row(label: String, value: String, paperWidth: Int = 80): ESCPOSBuilder {
        val width = if (paperWidth == 80) 48 else 32
        val gap = (width - label.length - value.length).coerceAtLeast(1)
        return line(label + " ".repeat(gap) + value)
    }

    fun qr(data: String, model: Int = 2, size: Int = 6, ec: String = "M"): ESCPOSBuilder {
        val moduleSize = size.coerceIn(1, 16)
        val ecMap = mapOf("L" to 48, "M" to 49, "Q" to 50, "H" to 51)
        val ecByte = (ecMap[ec] ?: 49).toByte()

        // Model (fn 65)
        out.write(byteArrayOf(GS, 0x28, 0x6B, 4, 0, 49, 65, (model + 49).toByte(), 0))
        // Module size (fn 67)
        out.write(byteArrayOf(GS, 0x28, 0x6B, 3, 0, 49, 67, moduleSize.toByte()))
        // Error correction (fn 69)
        out.write(byteArrayOf(GS, 0x28, 0x6B, 3, 0, 49, 69, ecByte))

        // Store data (fn 80)
        val dataBuf = data.toByteArray(Charsets.UTF_8)
        val len = dataBuf.size + 3
        val pL = (len and 0xFF).toByte()
        val pH = ((len shr 8) and 0xFF).toByte()
        out.write(byteArrayOf(GS, 0x28, 0x6B, pL, pH, 49, 80, 48))
        out.write(dataBuf)

        // Print (fn 81)
        out.write(byteArrayOf(GS, 0x28, 0x6B, 3, 0, 49, 81, 48))
        return this
    }

    fun barcode(
        data: String,
        type: String = "CODE128",
        height: Int = 80,
        width: Int = 3,
        hriPosition: Int = 2
    ): ESCPOSBuilder {
        val typeMap = mapOf(
            "UPC-A" to 65, "UPC-E" to 66, "EAN13" to 67, "EAN8" to 68,
            "CODE39" to 69, "ITF" to 70, "CODE93" to 72, "CODE128" to 73
        )
        val t = (typeMap[type] ?: 73).toByte()
        val h = height.coerceIn(1, 255).toByte()
        val w = width.coerceIn(2, 6).toByte()
        val hri = hriPosition.toByte()

        out.write(byteArrayOf(GS, 0x68, h)) // height
        out.write(byteArrayOf(GS, 0x77, w)) // width
        out.write(byteArrayOf(GS, 0x48, hri)) // HRI position

        val dataBuf = data.toByteArray(Charsets.US_ASCII)
        out.write(byteArrayOf(GS, 0x6B, t, dataBuf.size.toByte()))
        out.write(dataBuf)
        return this
    }

    fun rasterImage(rasterBytes: ByteArray, widthBytes: Int, heightDots: Int): ESCPOSBuilder {
        val m: Byte = 0
        val xL = (widthBytes and 0xFF).toByte()
        val xH = ((widthBytes shr 8) and 0xFF).toByte()
        val yL = (heightDots and 0xFF).toByte()
        val yH = ((heightDots shr 8) and 0xFF).toByte()
        out.write(byteArrayOf(GS, 0x76, 0x30, m, xL, xH, yL, yH))
        out.write(rasterBytes)
        return this
    }

    fun drawerKick(pin: Int = 0): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x70, pin.toByte(), 0x32, 0x78))
        return this
    }

    fun cut(full: Boolean = true): ESCPOSBuilder {
        feed(1)
        out.write(byteArrayOf(GS, 0x56, if (full) 0x00 else 0x01))
        return this
    }

    fun build(): ByteArray = out.toByteArray()

    fun toBase64(): String = android.util.Base64.encodeToString(build(), android.util.Base64.NO_WRAP)

    private fun encodeText(s: String): ByteArray {
        return if (currentCodePage == CP1256.CODE_PAGE) {
            CP1256.encode(s)
        } else {
            s.toByteArray(Charsets.ISO_8859_1)
        }
    }
}
```

- [ ] **Step 10: Run ESCPOSBuilder tests — verify they pass**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.escpos.ESCPOSBuilderTest"
```
Expected: 7 tests PASS.

- [ ] **Step 11: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/escpos/ \
        android/app/src/test/java/com/kliovo/printagent/escpos/
git commit -m "feat(android): port ESCPOSBuilder, CP1256, FormatPaisa from TypeScript"
```

---

### Task 6: Render templates — receipt, KOT, master KOT, void KOT, label

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/render/PrintJobData.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/render/ReceiptRenderer.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/render/KotRenderer.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/render/MasterKotRenderer.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/render/VoidKotRenderer.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/render/LabelRenderer.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/render/ReceiptRendererTest.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/render/KotRendererTest.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/render/LabelRendererTest.kt`

- [ ] **Step 1: Write renderer tests**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/render/ReceiptRendererTest.kt
package com.kliovo.printagent.render

import org.junit.Assert.*
import org.junit.Test

class ReceiptRendererTest {

    @Test
    fun `renders minimal receipt without crashing`() {
        val input = ReceiptInput(
            header = ReceiptHeader(tenantName = "Test Cafe"),
            referenceNumber = "ORD-001",
            date = "2026-06-24",
            time = "14:30",
            orderType = "dine_in",
            items = listOf(
                ReceiptItem(name = "Burger", quantity = 2, unitPricePaisa = 50000, totalPricePaisa = 100000)
            ),
            subtotalPaisa = 100000,
            totalPaisa = 100000,
            paidPaisa = 100000,
            balanceDuePaisa = 0,
            payments = listOf(ReceiptPayment(method = "cash", amountPaisa = 100000))
        )
        val bytes = ReceiptRenderer.render(input)
        assertTrue(bytes.isNotEmpty())
        // Starts with ESC @ (init)
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x40.toByte(), bytes[1])
    }

    @Test
    fun `receipt contains tenant name`() {
        val input = ReceiptInput(
            header = ReceiptHeader(tenantName = "BurgerLub"),
            referenceNumber = "ORD-002",
            date = "2026-06-24",
            time = "15:00",
            orderType = "takeaway",
            items = listOf(
                ReceiptItem(name = "Fries", quantity = 1, unitPricePaisa = 20000, totalPricePaisa = 20000)
            ),
            subtotalPaisa = 20000,
            totalPaisa = 20000,
            paidPaisa = 20000,
            balanceDuePaisa = 0,
            payments = listOf(ReceiptPayment(method = "cash", amountPaisa = 20000))
        )
        val bytes = ReceiptRenderer.render(input)
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("BurgerLub"))
    }

    @Test
    fun `receipt ends with cut command`() {
        val input = ReceiptInput(
            header = ReceiptHeader(tenantName = "X"),
            referenceNumber = "ORD-003",
            date = "d",
            time = "t",
            orderType = "dine_in",
            items = listOf(
                ReceiptItem(name = "Item", quantity = 1, unitPricePaisa = 100, totalPricePaisa = 100)
            ),
            subtotalPaisa = 100,
            totalPaisa = 100,
            paidPaisa = 100,
            balanceDuePaisa = 0,
            payments = emptyList()
        )
        val bytes = ReceiptRenderer.render(input)
        // Last 2 bytes should be GS V 0x00 (full cut)
        assertEquals(0x1D.toByte(), bytes[bytes.size - 2])
        assertEquals(0x56.toByte(), bytes[bytes.size - 1])
    }
}
```

```kotlin
// android/app/src/test/java/com/kliovo/printagent/render/KotRendererTest.kt
package com.kliovo.printagent.render

import org.junit.Assert.*
import org.junit.Test

class KotRendererTest {

    @Test
    fun `renders basic KOT`() {
        val input = KotInput(
            referenceNumber = "ORD-001",
            stationName = "Grill",
            fireTime = "14:30",
            items = listOf(
                KotItem(name = "Burger", quantity = 2)
            )
        )
        val bytes = KotRenderer.render(input)
        assertTrue(bytes.isNotEmpty())
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("GRILL"))
        assertTrue(text.contains("2 x Burger"))
    }

    @Test
    fun `urgent KOT contains URGENT banner`() {
        val input = KotInput(
            referenceNumber = "ORD-002",
            stationName = "Fry",
            fireTime = "14:35",
            isUrgent = true,
            urgencyLabel = "12 min overdue",
            items = listOf(KotItem(name = "Fries", quantity = 1))
        )
        val bytes = KotRenderer.render(input)
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("URGENT"))
    }
}
```

```kotlin
// android/app/src/test/java/com/kliovo/printagent/render/LabelRendererTest.kt
package com.kliovo.printagent.render

import org.junit.Assert.*
import org.junit.Test

class LabelRendererTest {

    @Test
    fun `renders label with reference number`() {
        val input = LabelInput(
            referenceNumber = "ORD-100",
            customerName = "Ali",
            orderType = "delivery"
        )
        val bytes = LabelRenderer.render(input)
        assertTrue(bytes.isNotEmpty())
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("ORD-100"))
        assertTrue(text.contains("Ali"))
    }
}
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.render.*"
```
Expected: FAIL — classes not found.

- [ ] **Step 3: Implement PrintJobData.kt — all data classes**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/render/PrintJobData.kt
package com.kliovo.printagent.render

// ── Receipt types ───────────────────────────────────────────

data class ReceiptHeader(
    val tenantName: String,
    val branchName: String? = null,
    val addressLines: List<String>? = null,
    val phone: String? = null,
    val taxLines: List<String>? = null,
    val rasterLogo: RasterLogo? = null
)

data class RasterLogo(
    val bytes: ByteArray,
    val widthBytes: Int,
    val heightDots: Int
)

data class ReceiptFooter(
    val lines: List<String>? = null,
    val qrLink: String? = null,
    val fbrVerifyUrl: String? = null
)

data class ReceiptItem(
    val name: String,
    val nameAlt: String? = null,
    val quantity: Int,
    val unitPricePaisa: Long,
    val totalPricePaisa: Long,
    val modifiers: List<ItemModifier>? = null,
    val notes: String? = null
)

data class ItemModifier(
    val name: String,
    val pricePaisa: Long = 0
)

data class ReceiptPayment(
    val method: String,
    val amountPaisa: Long,
    val tipPaisa: Long = 0,
    val reference: String? = null
)

data class Discount(
    val label: String,
    val amountPaisa: Long,
    val percentage: Double? = null
)

data class Tax(
    val label: String,
    val rate: Double,
    val amountPaisa: Long
)

data class Customer(
    val name: String? = null,
    val phone: String? = null
)

data class SectionStyle(
    val visible: Boolean? = null,
    val fontSize: String? = null,
    val align: String? = null,
    val bold: Boolean? = null,
    val nameSize: String? = null,
    val totalSize: String? = null,
    val lines: List<String>? = null
)

data class LayoutConfig(
    val paperWidth: Int? = null,
    val header: SectionStyle? = null,
    val orderMeta: SectionStyle? = null,
    val items: SectionStyle? = null,
    val totals: SectionStyle? = null,
    val payments: SectionStyle? = null,
    val footer: SectionStyle? = null
)

data class ReceiptInput(
    val paperWidth: Int = 80,
    val header: ReceiptHeader,
    val footer: ReceiptFooter? = null,
    val referenceNumber: String,
    val date: String,
    val time: String,
    val orderType: String,
    val tableName: String? = null,
    val serverName: String? = null,
    val covers: Int? = null,
    val customer: Customer? = null,
    val deliveryAddress: String? = null,
    val specialRequests: String? = null,
    val items: List<ReceiptItem>,
    val subtotalPaisa: Long,
    val discounts: List<Discount>? = null,
    val taxes: List<Tax>? = null,
    val serviceChargePaisa: Long? = null,
    val tipPaisa: Long? = null,
    val totalPaisa: Long,
    val paidPaisa: Long,
    val balanceDuePaisa: Long,
    val payments: List<ReceiptPayment>,
    val fbrInvoiceNumber: String? = null,
    val version: Int? = null,
    val layoutConfig: LayoutConfig? = null
)

// ── KOT types ───────────────────────────────────────────────

data class KotItem(
    val name: String,
    val nameAlt: String? = null,
    val quantity: Int,
    val modifiers: List<KotModifier>? = null,
    val notes: String? = null,
    val course: String? = null
)

data class KotModifier(val name: String)

data class KotInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val stationName: String,
    val stationEmoji: String? = null,
    val tableName: String? = null,
    val guestName: String? = null,
    val serverName: String? = null,
    val orderType: String? = null,
    val fireTime: String,
    val fireDate: String? = null,
    val isUrgent: Boolean = false,
    val urgencyLabel: String? = null,
    val isRecall: Boolean = false,
    val items: List<KotItem>,
    val version: Int? = null
)

// ── Master KOT types ────────────────────────────────────────

data class MasterKotStationGroup(
    val stationName: String,
    val stationEmoji: String? = null,
    val items: List<KotItem>
)

data class MasterKotInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val tableName: String? = null,
    val guestName: String? = null,
    val serverName: String? = null,
    val orderType: String? = null,
    val fireTime: String,
    val fireDate: String? = null,
    val covers: Int? = null,
    val courseLabel: String? = null,
    val groups: List<MasterKotStationGroup>,
    val version: Int? = null
)

// ── Void KOT types ──────────────────────────────────────────

data class VoidKotItem(
    val name: String,
    val quantity: Int,
    val modifiers: List<KotModifier>? = null
)

data class VoidKotInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val stationName: String? = null,
    val tableName: String? = null,
    val serverName: String? = null,
    val authorisedBy: String? = null,
    val reason: String? = null,
    val voidTime: String,
    val voidDate: String? = null,
    val items: List<VoidKotItem>
)

// ── Label types ─────────────────────────────────────────────

data class LabelInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val bagIndex: Int? = null,
    val bagTotal: Int? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val deliveryAddress: String? = null,
    val orderType: String? = null,
    val scheduledFor: String? = null,
    val itemSummary: String? = null,
    val handlingNote: String? = null
)
```

- [ ] **Step 4: Implement ReceiptRenderer.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/render/ReceiptRenderer.kt
package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder
import com.kliovo.printagent.escpos.FormatPaisa

object ReceiptRenderer {

    private fun formatMoney(paisa: Long): String = "Rs ${FormatPaisa.format(paisa)}"

    fun render(input: ReceiptInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val width = if (pw == 80) 48 else 32

        val lc = input.layoutConfig
        val headerStyle = lc?.header
        val footerStyle = lc?.footer

        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        // Header
        if (input.header.rasterLogo != null) {
            val logo = input.header.rasterLogo
            b.align("center").rasterImage(logo.bytes, logo.widthBytes, logo.heightDots).newline()
        }

        b.align(headerStyle?.align ?: "center")
        b.size(headerStyle?.nameSize ?: "large").bold(headerStyle?.bold ?: true)
            .line(input.header.tenantName).bold(false).size("normal")

        input.header.branchName?.let { b.line(it) }
        input.header.addressLines?.forEach { b.line(it) }
        input.header.phone?.let { b.line(it) }
        input.header.taxLines?.forEach { b.line(it) }

        b.rule(pw, "=").align("left")

        // Order meta
        b.bold(true).line(input.referenceNumber).bold(false)
        b.row(input.date, input.time, pw)
        b.row("Type", input.orderType.uppercase(), pw)
        input.tableName?.let { b.row("Table", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.covers?.let { b.row("Covers", it.toString(), pw) }
        input.customer?.name?.let { b.row("Customer", it, pw) }
        input.customer?.phone?.let { b.row("Phone", it, pw) }
        input.deliveryAddress?.let { addr ->
            b.line("Address:")
            wrap(addr, width).forEach { b.line("  $it") }
        }
        input.specialRequests?.let { req ->
            b.line("Notes:")
            wrap(req, width).forEach { b.line("  $it") }
        }

        b.rule(pw)

        // Items
        for (item in input.items) {
            val left = "${item.quantity} x ${item.name}"
            val right = formatMoney(item.totalPricePaisa)
            b.row(truncate(left, width - right.length - 1), right, pw)
            item.nameAlt?.let { b.line("  $it") }
            item.modifiers?.forEach { mod ->
                val mLeft = "  + ${mod.name}"
                val mRight = if (mod.pricePaisa > 0) formatMoney(mod.pricePaisa) else ""
                if (mRight.isNotEmpty()) b.row(mLeft, mRight, pw) else b.line(mLeft)
            }
            item.notes?.let { notes ->
                wrap(notes, width - 4).forEach { b.line("    $it") }
            }
        }

        b.rule(pw)

        // Totals
        b.row("Subtotal", formatMoney(input.subtotalPaisa), pw)
        input.discounts?.forEach { d ->
            val label = if (d.percentage != null) "${d.label} (${d.percentage}%)" else d.label
            b.row(label, "- ${formatMoney(d.amountPaisa)}", pw)
        }
        input.taxes?.forEach { t ->
            b.row("${t.label} (${t.rate}%)", formatMoney(t.amountPaisa), pw)
        }
        input.serviceChargePaisa?.let { b.row("Service", formatMoney(it), pw) }
        input.tipPaisa?.let { b.row("Tip", formatMoney(it), pw) }

        b.rule(pw, "=")
        b.size("large").bold(true).row("TOTAL", formatMoney(input.totalPaisa), pw).bold(false).size("normal")
        b.rule(pw, "=")

        // Payments
        for (p in input.payments) {
            val label = if (p.reference != null) "${p.method.uppercase()} (${p.reference})" else p.method.uppercase()
            b.row(label, formatMoney(p.amountPaisa), pw)
        }
        if (input.balanceDuePaisa > 0) {
            b.bold(true).row("BALANCE DUE", formatMoney(input.balanceDuePaisa), pw).bold(false)
        } else {
            b.row("PAID", formatMoney(input.paidPaisa), pw)
        }

        // FBR
        input.fbrInvoiceNumber?.let { fbr ->
            b.newline().align("center").bold(true).line("FBR # $fbr").bold(false)
            input.footer?.fbrVerifyUrl?.let { url ->
                b.qr(url, size = 5, ec = "M")
                b.line("Scan to verify with FBR")
            }
        }

        // Footer
        input.footer?.qrLink?.let { b.newline().qr(it, size = 5, ec = "M") }
        val footerLines = footerStyle?.lines ?: input.footer?.lines
        if (!footerLines.isNullOrEmpty()) {
            b.newline()
            for (ln in footerLines) {
                b.align(footerStyle?.align ?: "center").line(ln)
            }
        }
        b.newline().align("center").size("small").line("Powered by Kliovo Dine").size("normal")

        return b.feed(5).cut(true).build()
    }

    private fun wrap(s: String, width: Int): List<String> {
        val out = mutableListOf<String>()
        val words = s.split(Regex("\\s+"))
        var line = ""
        for (w in words) {
            if (("$line $w").trim().length > width) {
                if (line.isNotEmpty()) out.add(line)
                line = w
            } else {
                line = if (line.isEmpty()) w else "$line $w"
            }
        }
        if (line.isNotEmpty()) out.add(line)
        return if (out.isNotEmpty()) out else listOf(s.take(width))
    }

    private fun truncate(s: String, max: Int): String {
        return if (s.length > max) s.take(max - 1) + "…" else s
    }
}
```

- [ ] **Step 5: Implement KotRenderer.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/render/KotRenderer.kt
package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object KotRenderer {

    fun render(input: KotInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        // Banners
        if (input.isRecall) {
            b.align("center").invert(true).size("large").bold(true)
                .line(" * * RECALL * * ").bold(false).size("normal").invert(false)
        }
        if (input.isUrgent) {
            b.align("center").invert(true).bold(true)
                .line(" URGENT ${input.urgencyLabel ?: ""} ").bold(false).invert(false)
        }

        // Station header
        b.align("center").size("xlarge").bold(true)
        val emoji = if (input.stationEmoji != null) "${input.stationEmoji} " else ""
        b.line("$emoji${input.stationName.uppercase()}")
        b.bold(false).size("normal").rule(pw, "=")

        // Order meta
        b.align("left")
        b.size("large").bold(true).line(input.referenceNumber).bold(false).size("normal")
        input.tableName?.let { b.row("Table", it, pw) }
        input.guestName?.let { b.row("Guest", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.orderType?.let { b.row("Type", it.uppercase(), pw) }
        val firedValue = "${input.fireDate?.let { "$it " } ?: ""}${input.fireTime}"
        b.row("Fired", firedValue, pw)

        b.rule(pw)

        // Items
        for (item in input.items) {
            b.size("large").bold(true)
            b.line("${item.quantity} x ${item.name}")
            b.bold(false).size("normal")
            item.nameAlt?.let { b.line("  $it") }
            item.course?.let { b.line("  [$it]") }
            item.modifiers?.forEach { b.line("  + ${it.name}") }
            item.notes?.let { b.bold(true).line("  ! $it").bold(false) }
            b.newline()
        }

        b.rule(pw, "=")
        input.version?.takeIf { it > 1 }?.let {
            b.align("center").bold(true).line("** REPRINT v$it **").bold(false)
        }

        b.align("center").size("small")
            .line("─────────────────────")
            .line("Powered by Kliovo Dine").size("normal")

        return b.feed(2).cut(false).build()
    }
}
```

- [ ] **Step 6: Implement MasterKotRenderer.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/render/MasterKotRenderer.kt
package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object MasterKotRenderer {

    fun render(input: MasterKotInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        b.align("center").size("xlarge").bold(true).line("MASTER KOT").bold(false).size("normal")
        b.rule(pw, "=")

        b.align("left").size("large").bold(true).line(input.referenceNumber).bold(false).size("normal")
        input.tableName?.let { b.row("Table", it, pw) }
        input.guestName?.let { b.row("Guest", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.covers?.let { b.row("Covers", it.toString(), pw) }
        input.orderType?.let { b.row("Type", it.uppercase(), pw) }
        input.courseLabel?.let { b.row("Course", it, pw) }
        val firedValue = "${input.fireDate?.let { "$it " } ?: ""}${input.fireTime}"
        b.row("Fired", firedValue, pw)

        b.rule(pw)

        for (group in input.groups) {
            val emoji = if (group.stationEmoji != null) "${group.stationEmoji} " else ""
            b.bold(true).line("-- $emoji${group.stationName.uppercase()} --").bold(false)
            for (item in group.items) {
                b.size("large").bold(true).line("${item.quantity} x ${item.name}").bold(false).size("normal")
                item.nameAlt?.let { b.line("  $it") }
                item.modifiers?.forEach { b.line("  + ${it.name}") }
                item.notes?.let { b.bold(true).line("  ! $it").bold(false) }
            }
            b.newline()
        }

        b.rule(pw, "=")
        input.version?.takeIf { it > 1 }?.let {
            b.align("center").bold(true).line("** REPRINT v$it **").bold(false)
        }

        b.align("center").size("small")
            .line("─────────────────────")
            .line("Powered by Kliovo Dine").size("normal")

        return b.feed(2).cut(false).build()
    }
}
```

- [ ] **Step 7: Implement VoidKotRenderer.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/render/VoidKotRenderer.kt
package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object VoidKotRenderer {

    fun render(input: VoidKotInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        b.align("center").invert(true).size("xlarge").bold(true)
        b.line("  V O I D  ")
        b.bold(false).size("normal").invert(false)
        b.rule(pw, "=")

        b.align("left").bold(true).line(input.referenceNumber).bold(false)
        input.stationName?.let { b.row("Station", it, pw) }
        input.tableName?.let { b.row("Table", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.authorisedBy?.let { b.row("Authorised", it, pw) }
        val voidedValue = "${input.voidDate?.let { "$it " } ?: ""}${input.voidTime}"
        b.row("Voided", voidedValue, pw)

        b.rule(pw)
        b.bold(true).line("PULL THESE ITEMS:").bold(false)
        for (item in input.items) {
            b.size("large").bold(true).line("${item.quantity} x ${item.name}").bold(false).size("normal")
            item.modifiers?.forEach { b.line("  + ${it.name}") }
        }

        input.reason?.let {
            b.rule(pw)
            b.bold(true).line("Reason:").bold(false)
            b.line(it)
        }

        b.rule(pw, "=")
        b.align("center").size("small")
            .line("─────────────────────")
            .line("Powered by Kliovo Dine").size("normal")

        return b.feed(2).cut(false).build()
    }
}
```

- [ ] **Step 8: Implement LabelRenderer.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/render/LabelRenderer.kt
package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object LabelRenderer {

    fun render(input: LabelInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        b.align("center").size("large").bold(true).line(input.referenceNumber).bold(false).size("normal")

        if (input.bagIndex != null && input.bagTotal != null) {
            b.align("center").bold(true).line("Bag ${input.bagIndex} of ${input.bagTotal}").bold(false)
        }

        b.align("center").barcode(input.referenceNumber, type = "CODE128", height = 60, hriPosition = 0)
        b.rule(pw)

        b.align("left")
        input.orderType?.let { b.row("Type", it.uppercase(), pw) }
        input.scheduledFor?.let { b.row("For", it, pw) }
        input.customerName?.let { b.row("Name", it, pw) }
        input.customerPhone?.let { b.row("Phone", it, pw) }
        input.deliveryAddress?.let {
            b.line("Address:")
            b.line(it)
        }
        input.itemSummary?.let {
            b.rule(pw)
            b.line(it)
        }
        input.handlingNote?.let {
            b.bold(true).line("! $it").bold(false)
        }

        return b.feed(1).cut(false).build()
    }
}
```

- [ ] **Step 9: Run renderer tests — verify they pass**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.render.*"
```
Expected: 6 tests PASS.

- [ ] **Step 10: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/render/ \
        android/app/src/test/java/com/kliovo/printagent/render/
git commit -m "feat(android): port all 5 ESC/POS render templates from TypeScript"
```

---

### Task 7: Bridge server — NanoHTTPD with all endpoints

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/bridge/IdempotencyGuard.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/bridge/BridgeServer.kt`
- Create: `android/app/src/test/java/com/kliovo/printagent/bridge/IdempotencyGuardTest.kt`

- [ ] **Step 1: Write IdempotencyGuard test**

```kotlin
// android/app/src/test/java/com/kliovo/printagent/bridge/IdempotencyGuardTest.kt
package com.kliovo.printagent.bridge

import org.junit.Assert.*
import org.junit.Test

class IdempotencyGuardTest {

    @Test
    fun `first key returns false`() {
        val guard = IdempotencyGuard()
        assertFalse(guard.seenRecently("key-1"))
    }

    @Test
    fun `same key returns true`() {
        val guard = IdempotencyGuard()
        guard.seenRecently("key-1")
        assertTrue(guard.seenRecently("key-1"))
    }

    @Test
    fun `different keys are independent`() {
        val guard = IdempotencyGuard()
        guard.seenRecently("key-1")
        assertFalse(guard.seenRecently("key-2"))
    }
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.bridge.IdempotencyGuardTest"
```
Expected: FAIL.

- [ ] **Step 3: Implement IdempotencyGuard.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/bridge/IdempotencyGuard.kt
package com.kliovo.printagent.bridge

class IdempotencyGuard(private val ttlMs: Long = 60_000L) {

    private val seen = mutableMapOf<String, Long>()

    fun seenRecently(key: String): Boolean {
        val now = System.currentTimeMillis()
        seen.entries.removeAll { now - it.value > ttlMs }
        if (seen.containsKey(key)) return true
        seen[key] = now
        return false
    }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.bridge.IdempotencyGuardTest"
```
Expected: 3 tests PASS.

- [ ] **Step 5: Implement BridgeServer.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/bridge/BridgeServer.kt
package com.kliovo.printagent.bridge

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.printer.TcpPrinterSender
import com.kliovo.printagent.render.*
import fi.iki.elonen.NanoHTTPD
import java.util.concurrent.Executors

class BridgeServer(
    private val configStore: ConfigStore,
    private val healthTracker: HealthTracker,
    private val appVersion: String
) : NanoHTTPD("127.0.0.1", PORT) {

    private val gson = Gson()
    private val idempotency = IdempotencyGuard()
    private val executor = Executors.newFixedThreadPool(2)

    companion object {
        const val PORT = 6310
        private const val TAG = "BridgeServer"
    }

    private val corsHeaders = mapOf(
        "Access-Control-Allow-Origin" to "*",
        "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers" to "Content-Type, X-Agent-Secret, X-Aster-Token",
        "Access-Control-Allow-Private-Network" to "true"
    )

    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.OPTIONS) {
            return newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, "").also {
                corsHeaders.forEach { (k, v) -> it.addHeader(k, v) }
            }
        }

        val resp = when {
            session.method == Method.GET && session.uri == "/ping" -> handlePing()
            session.method == Method.GET && session.uri == "/status" -> handleStatus()
            session.method == Method.POST && session.uri == "/print" -> handlePrint(session)
            session.method == Method.POST && session.uri == "/render-print" -> handleRenderPrint(session)
            else -> jsonResponse(Response.Status.NOT_FOUND, mapOf("ok" to false, "error" to "Not found"))
        }

        corsHeaders.forEach { (k, v) -> resp.addHeader(k, v) }
        return resp
    }

    private fun handlePing(): Response {
        val config = configStore.load()
        return jsonResponse(
            Response.Status.OK,
            mapOf(
                "ok" to true,
                "version" to appVersion,
                "printers" to config.printers.map { it.printerId }
            )
        )
    }

    private fun handleStatus(): Response {
        val snap = healthTracker.snapshot()
        return jsonResponse(
            Response.Status.OK,
            mapOf(
                "ok" to true,
                "version" to appVersion,
                "status" to snap.status,
                "printers" to snap.printers,
                "recent" to snap.recent
            )
        )
    }

    private fun handlePrint(session: IHTTPSession): Response {
        val body = readBody(session)
        return try {
            val json = JsonParser.parseString(body).asJsonObject
            val printJobId = json.get("printJobId")?.asString
            val printerId = json.get("printerId")?.asString ?: return errorResponse("printerId required")
            val bytesBase64 = json.get("bytesBase64")?.asString ?: return errorResponse("bytesBase64 required")

            val config = configStore.load()
            val pc = config.printers.find { it.printerId == printerId }
                ?: return jsonResponse(Response.Status.NOT_FOUND, mapOf("ok" to false, "error" to "Printer $printerId not in config"))

            Log.i(TAG, "received raw job ${printJobId ?: "?"} for $printerId")
            val bytes = android.util.Base64.decode(bytesBase64, android.util.Base64.DEFAULT)
            TcpPrinterSender.send(pc.host, pc.port, bytes)
            healthTracker.record(printerId, pc.name, "raw", true, null)
            jsonResponse(Response.Status.OK, mapOf("ok" to true))
        } catch (e: Exception) {
            Log.e(TAG, "print error: ${e.message}")
            val printerId = try { JsonParser.parseString(body).asJsonObject.get("printerId")?.asString } catch (_: Exception) { null }
            if (printerId != null) {
                healthTracker.record(printerId, printerId, "raw", false, e.message)
            }
            jsonResponse(Response.Status.INTERNAL_ERROR, mapOf("ok" to false, "error" to (e.message ?: "unknown")))
        }
    }

    private fun handleRenderPrint(session: IHTTPSession): Response {
        val body = readBody(session)
        return try {
            val json = JsonParser.parseString(body).asJsonObject
            val printJobId = json.get("printJobId")?.asString
            val printerId = json.get("printerId")?.asString ?: return errorResponse("printerId required")
            val idempotencyKey = json.get("idempotencyKey")?.asString
            val jobObj = json.getAsJsonObject("job") ?: return errorResponse("job required")
            val kind = jobObj.get("kind")?.asString ?: return errorResponse("job.kind required")

            val dedupKey = idempotencyKey ?: printJobId
            if (dedupKey != null && idempotency.seenRecently(dedupKey)) {
                Log.i(TAG, "dedup — skipped duplicate job $dedupKey")
                return jsonResponse(Response.Status.OK, mapOf("ok" to true, "deduped" to true))
            }

            val config = configStore.load()
            val pc = config.printers.find { it.printerId == printerId }
                ?: return jsonResponse(Response.Status.NOT_FOUND, mapOf("ok" to false, "error" to "Printer $printerId not in config"))

            Log.i(TAG, "received $kind job ${printJobId ?: dedupKey ?: "?"} for $printerId")
            val inputObj = jobObj.getAsJsonObject("input")
            val paperWidth = pc.paperWidth

            val bytes = renderJob(kind, inputObj, paperWidth)
            TcpPrinterSender.send(pc.host, pc.port, bytes)
            healthTracker.record(printerId, pc.name, kind, true, null)
            jsonResponse(Response.Status.OK, mapOf("ok" to true, "rendered" to true))
        } catch (e: Exception) {
            Log.e(TAG, "render-print error: ${e.message}")
            val printerId = try { JsonParser.parseString(body).asJsonObject.get("printerId")?.asString } catch (_: Exception) { null }
            val kind = try { JsonParser.parseString(body).asJsonObject.getAsJsonObject("job")?.get("kind")?.asString } catch (_: Exception) { null }
            if (printerId != null) {
                healthTracker.record(printerId, printerId, kind ?: "unknown", false, e.message)
            }
            jsonResponse(Response.Status.INTERNAL_ERROR, mapOf("ok" to false, "error" to (e.message ?: "unknown")))
        }
    }

    private fun renderJob(kind: String, input: JsonObject, paperWidth: Int): ByteArray {
        return when (kind) {
            "receipt" -> {
                val ri = gson.fromJson(input, ReceiptInput::class.java).copy(paperWidth = paperWidth)
                ReceiptRenderer.render(ri)
            }
            "kot" -> {
                val ki = gson.fromJson(input, KotInput::class.java).copy(paperWidth = paperWidth)
                KotRenderer.render(ki)
            }
            "master_kot" -> {
                val mi = gson.fromJson(input, MasterKotInput::class.java).copy(paperWidth = paperWidth)
                MasterKotRenderer.render(mi)
            }
            "void_kot" -> {
                val vi = gson.fromJson(input, VoidKotInput::class.java).copy(paperWidth = paperWidth)
                VoidKotRenderer.render(vi)
            }
            "label" -> {
                val li = gson.fromJson(input, LabelInput::class.java).copy(paperWidth = paperWidth)
                LabelRenderer.render(li)
            }
            else -> throw IllegalArgumentException("Unknown print job kind: $kind")
        }
    }

    private fun readBody(session: IHTTPSession): String {
        val files = mutableMapOf<String, String>()
        session.parseBody(files)
        return files["postData"] ?: ""
    }

    private fun jsonResponse(status: Response.Status, data: Any): Response {
        return newFixedLengthResponse(status, "application/json", gson.toJson(data))
    }

    private fun errorResponse(msg: String): Response {
        return jsonResponse(Response.Status.BAD_REQUEST, mapOf("ok" to false, "error" to msg))
    }
}
```

- [ ] **Step 6: Run IdempotencyGuard tests — verify they pass**

```bash
cd android && ./gradlew test --tests "com.kliovo.printagent.bridge.IdempotencyGuardTest"
```
Expected: 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/bridge/ \
        android/app/src/test/java/com/kliovo/printagent/bridge/
git commit -m "feat(android): add BridgeServer (NanoHTTPD) with /ping /print /render-print /status"
```

---

### Task 8: Foreground service + boot receiver

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/service/PrintBridgeService.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/service/BootReceiver.kt`

- [ ] **Step 1: Implement PrintBridgeService.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/service/PrintBridgeService.kt
package com.kliovo.printagent.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.kliovo.printagent.KliovoPrintApp
import com.kliovo.printagent.R
import com.kliovo.printagent.bridge.BridgeServer
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.ui.MainActivity

class PrintBridgeService : Service() {

    private var server: BridgeServer? = null

    companion object {
        private const val TAG = "PrintBridgeService"
        private const val NOTIFICATION_ID = 1
        val healthTracker = HealthTracker()
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())

        if (server == null) {
            try {
                val configStore = ConfigStore(applicationContext)
                val version = packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
                server = BridgeServer(configStore, healthTracker, version)
                server?.start()
                Log.i(TAG, "Bridge server started on port ${BridgeServer.PORT}")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start bridge server: ${e.message}")
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        Log.i(TAG, "Service destroyed, server stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, KliovoPrintApp.CHANNEL_ID)
            .setContentTitle("Kliovo Print Agent")
            .setContentText("Print bridge running on port ${BridgeServer.PORT}")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
```

- [ ] **Step 2: Implement BootReceiver.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/service/BootReceiver.kt
package com.kliovo.printagent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i("BootReceiver", "Boot completed — starting PrintBridgeService")
            val serviceIntent = Intent(context, PrintBridgeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        }
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/service/
git commit -m "feat(android): add ForegroundService + BootReceiver for bridge lifecycle"
```

---

### Task 9: Compose UI — theme, MainActivity, screens

**Files:**
- Create: `android/app/src/main/java/com/kliovo/printagent/ui/theme/Theme.kt`
- Create: `android/app/src/main/java/com/kliovo/printagent/ui/MainActivity.kt`

- [ ] **Step 1: Implement Theme.kt**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/ui/theme/Theme.kt
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
```

- [ ] **Step 2: Implement MainActivity.kt — full app with all screens**

```kotlin
// android/app/src/main/java/com/kliovo/printagent/ui/MainActivity.kt
package com.kliovo.printagent.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kliovo.printagent.config.AgentConfig
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.config.PrinterEntry
import com.kliovo.printagent.health.HealthSnapshot
import com.kliovo.printagent.health.JobEvent
import com.kliovo.printagent.printer.TcpPrinterSender
import com.kliovo.printagent.service.PrintBridgeService
import com.kliovo.printagent.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : ComponentActivity() {

    private lateinit var configStore: ConfigStore

    private val notifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configStore = ConfigStore(applicationContext)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        requestBatteryOptimizationExemption()
        startBridgeService()

        setContent {
            KliovoPrintAgentTheme {
                PrintAgentApp(configStore)
            }
        }
    }

    private fun startBridgeService() {
        val intent = Intent(this, PrintBridgeService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun requestBatteryOptimizationExemption() {
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            try { startActivity(intent) } catch (_: Exception) {}
        }
    }
}

@Composable
fun PrintAgentApp(configStore: ConfigStore) {
    var config by remember { mutableStateOf(configStore.load()) }
    var editingIndex by remember { mutableIntStateOf(-1) }
    var showForm by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    // Poll health every 2 seconds
    var healthSnapshot by remember { mutableStateOf<HealthSnapshot?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            healthSnapshot = PrintBridgeService.healthTracker.snapshot()
            delay(2000)
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = KliovoBg
    ) {
        if (showForm) {
            val existing = if (editingIndex >= 0) config.printers[editingIndex] else null
            PrinterFormScreen(
                existing = existing,
                onSave = { entry ->
                    val printers = config.printers.toMutableList()
                    if (editingIndex >= 0) printers[editingIndex] = entry
                    else printers.add(entry)
                    config = config.copy(printers = printers)
                    configStore.save(config)
                    showForm = false
                    editingIndex = -1
                },
                onDelete = if (editingIndex >= 0) {
                    {
                        val printers = config.printers.toMutableList()
                        printers.removeAt(editingIndex)
                        config = config.copy(printers = printers)
                        configStore.save(config)
                        showForm = false
                        editingIndex = -1
                    }
                } else null,
                onCancel = {
                    showForm = false
                    editingIndex = -1
                },
                onTestPrint = { entry ->
                    scope.launch {
                        statusMessage = "Sending test print..."
                        try {
                            val ESC = 0x1B.toByte()
                            val GS = 0x1D.toByte()
                            val bytes = byteArrayOf(
                                ESC, 0x40,
                                ESC, 0x61, 0x01,
                                ESC, 0x21, 0x30
                            ) + "Kliovo\n".toByteArray() + byteArrayOf(
                                ESC, 0x21, 0x00
                            ) + "Test Print\n".toByteArray() +
                                "${entry.host}:${entry.port}\n".toByteArray() +
                                "${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}\n".toByteArray() +
                                byteArrayOf(GS, 0x56, 0x42, 0x00)

                            TcpPrinterSender.send(entry.host, entry.port, bytes)
                            PrintBridgeService.healthTracker.record(entry.printerId, entry.name, "test", true, null)
                            statusMessage = "Test print sent!"
                        } catch (e: Exception) {
                            PrintBridgeService.healthTracker.record(entry.printerId, entry.name, "test", false, e.message)
                            statusMessage = "Failed: ${e.message}"
                        }
                    }
                },
                statusMessage = statusMessage
            )
        } else {
            HomeScreen(
                config = config,
                healthSnapshot = healthSnapshot,
                onServerUrlChange = { url ->
                    config = config.copy(serverUrl = url)
                    configStore.save(config)
                },
                onAddPrinter = { showForm = true },
                onEditPrinter = { idx ->
                    editingIndex = idx
                    showForm = true
                }
            )
        }
    }
}

@Composable
fun HomeScreen(
    config: AgentConfig,
    healthSnapshot: HealthSnapshot?,
    onServerUrlChange: (String) -> Unit,
    onAddPrinter: () -> Unit,
    onEditPrinter: (Int) -> Unit
) {
    var serverUrl by remember(config.serverUrl) { mutableStateOf(config.serverUrl) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text(
                "Kliovo Print Agent",
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                color = KliovoDark
            )
            Spacer(Modifier.height(4.dp))
        }

        // Health card
        item {
            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = KliovoWhite)
            ) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val dotColor = when (healthSnapshot?.status) {
                            "green" -> KliovoGreen
                            "yellow" -> KliovoYellow
                            "red" -> KliovoRed
                            else -> KliovoMuted
                        }
                        Box(
                            Modifier
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(dotColor)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when (healthSnapshot?.status) {
                                "green" -> "Printing OK"
                                "yellow" -> "Recent print issues"
                                "red" -> "Print FAILING"
                                else -> "Loading..."
                            },
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp
                        )
                    }

                    if (healthSnapshot != null && healthSnapshot.recent.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
                        for (evt in healthSnapshot.recent.take(5)) {
                            Text(
                                "${timeFormat.format(Date(evt.ts))}  ${if (evt.ok) "✓" else "✗"} ${evt.kind} → ${evt.printerName}",
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                color = KliovoMuted
                            )
                        }
                    }
                }
            }
        }

        // Server URL
        item {
            SectionLabel("Server URL")
            OutlinedTextField(
                value = serverUrl,
                onValueChange = {
                    serverUrl = it
                    onServerUrlChange(it)
                },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                textStyle = LocalTextStyle.current.copy(fontSize = 13.sp),
                shape = RoundedCornerShape(8.dp)
            )
        }

        // Printers
        item { SectionLabel("Printers") }

        if (config.printers.isEmpty()) {
            item {
                Text("No printers configured", color = KliovoMuted, fontSize = 12.sp)
            }
        } else {
            items(config.printers.size) { idx ->
                val p = config.printers[idx]
                Card(
                    onClick = { onEditPrinter(idx) },
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = KliovoWhite)
                ) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name.ifEmpty { p.printerId }, fontWeight = FontWeight.Medium, fontSize = 13.sp)
                            Text("${p.host}:${p.port} • ${p.paperWidth}mm", color = KliovoMuted, fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        item {
            OutlinedButton(
                onClick = onAddPrinter,
                shape = RoundedCornerShape(8.dp)
            ) {
                Text("+ Add Printer", fontSize = 12.sp)
            }
        }
    }
}

@Composable
fun PrinterFormScreen(
    existing: PrinterEntry?,
    onSave: (PrinterEntry) -> Unit,
    onDelete: (() -> Unit)?,
    onCancel: () -> Unit,
    onTestPrint: (PrinterEntry) -> Unit,
    statusMessage: String
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var printerId by remember { mutableStateOf(existing?.printerId ?: "printer-${System.currentTimeMillis() % 10000}") }
    var host by remember { mutableStateOf(existing?.host ?: "") }
    var port by remember { mutableStateOf(existing?.port?.toString() ?: "9100") }
    var paperWidth by remember { mutableIntStateOf(existing?.paperWidth ?: 80) }

    fun buildEntry() = PrinterEntry(
        printerId = printerId,
        host = host,
        port = port.toIntOrNull() ?: 9100,
        name = name,
        paperWidth = paperWidth
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            if (existing != null) "Edit Printer" else "Add Printer",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )

        FormField("Printer Name", name) { name = it }
        FormField("Printer ID", printerId) { printerId = it }
        FormField("IP Address", host) { host = it }
        FormField("Port", port, KeyboardType.Number) { port = it }

        SectionLabel("Paper Width")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = paperWidth == 80,
                onClick = { paperWidth = 80 },
                label = { Text("80mm") }
            )
            FilterChip(
                selected = paperWidth == 58,
                onClick = { paperWidth = 58 },
                label = { Text("58mm") }
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(8.dp)) {
                Text("Cancel")
            }
            if (host.isNotEmpty()) {
                OutlinedButton(onClick = { onTestPrint(buildEntry()) }, shape = RoundedCornerShape(8.dp)) {
                    Text("Test Print")
                }
            }
            Button(
                onClick = { onSave(buildEntry()) },
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = KliovoGreen)
            ) {
                Text("Save")
            }
        }

        if (onDelete != null) {
            Button(
                onClick = onDelete,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = KliovoRed)
            ) {
                Text("Delete Printer")
            }
        }

        if (statusMessage.isNotEmpty()) {
            Text(statusMessage, fontSize = 12.sp, color = KliovoMuted)
        }
    }
}

@Composable
fun FormField(label: String, value: String, keyboardType: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    Column {
        SectionLabel(label)
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontSize = 13.sp),
            shape = RoundedCornerShape(8.dp),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType)
        )
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = KliovoMuted,
        letterSpacing = 0.5.sp
    )
}
```

- [ ] **Step 3: Verify full project compiles**

```bash
cd android && ./gradlew assembleDebug
```
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/kliovo/printagent/ui/ \
        android/app/src/main/java/com/kliovo/printagent/service/
git commit -m "feat(android): add Compose UI (home, printer form), ForegroundService, BootReceiver"
```

---

### Task 10: Run all tests and build release APK

**Files:** None — verification only.

- [ ] **Step 1: Run all unit tests**

```bash
cd android && ./gradlew test
```
Expected: All tests PASS (CP1256: 4, FormatPaisa: 4, ESCPOSBuilder: 7, ReceiptRenderer: 3, KotRenderer: 2, LabelRenderer: 1, IdempotencyGuard: 3, HealthTracker: 6, PrinterEntry: 3 = 33 tests total).

- [ ] **Step 2: Build debug APK**

```bash
cd android && ./gradlew assembleDebug
```
Expected: APK at `app/build/outputs/apk/debug/app-debug.apk`, ~8-12MB.

- [ ] **Step 3: Build release APK (unsigned)**

```bash
cd android && ./gradlew assembleRelease
```
Expected: APK at `app/build/outputs/apk/release/app-release-unsigned.apk`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(android): Kliovo Print Agent v1.0.0 — full build with all tests passing"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Scaffold Android project | Build check |
| 2 | Config layer (PrinterEntry, ConfigStore) | 3 |
| 3 | HealthTracker ring buffer | 6 |
| 4 | TCP printer sender | Manual |
| 5 | ESC/POS builder + CP1256 + FormatPaisa | 15 |
| 6 | 5 render templates | 6 |
| 7 | Bridge server (NanoHTTPD) | 3 |
| 8 | Foreground service + boot receiver | Build check |
| 9 | Compose UI (home, form) | Build check |
| 10 | Full test suite + APK build | All 33 |

Total: 10 tasks, 33 unit tests, produces a working APK that Chrome can talk to on `127.0.0.1:6310`.
