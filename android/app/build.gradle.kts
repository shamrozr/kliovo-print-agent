import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
}

// Release signing comes from CI secrets when present. Without them the release
// build falls back to the debug key: that still installs for sideloading, but
// the signature changes when real keys arrive, which forces an uninstall on
// every tablet. Set the secrets before shipping to branches.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
  if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystoreProps.getProperty("storeFile")?.isNotBlank() == true

android {
  namespace = "com.kliovo.printagent"
  compileSdk = 34

  defaultConfig {
    applicationId = "com.kliovo.printagent"
    minSdk = 24
    targetSdk = 34
    // Kept in step with package.json — the desktop installers and the APK are
    // ONE product on /downloads, and two version numbers under one name is a
    // support call waiting to happen. versionCode is versionName as digits.
    versionCode = 21103
    versionName = "2.11.3"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  signingConfigs {
    if (hasReleaseKeystore) {
      create("release") {
        storeFile = file(keystoreProps.getProperty("storeFile"))
        storePassword = keystoreProps.getProperty("storePassword")
        keyAlias = keystoreProps.getProperty("keyAlias")
        keyPassword = keystoreProps.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig =
        if (hasReleaseKeystore) signingConfigs.getByName("release")
        else signingConfigs.getByName("debug")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { compose = true }
  composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
  testOptions { unitTests { isIncludeAndroidResources = true } }
  packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
  implementation(libs.core.ktx)
  implementation(libs.lifecycle.service)
  implementation(libs.lifecycle.runtime.compose)
  implementation(libs.activity.compose)
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.ui.tooling.preview)
  implementation(libs.compose.material3)
  implementation(libs.coroutines.android)
  implementation(libs.nanohttpd)
  // OkHttp, not HttpURLConnection: the ACK is a real PATCH and HttpURLConnection
  // cannot send one (the route is PATCH-only, so an override header 405s).
  implementation(libs.okhttp)

  testImplementation(libs.junit)
  testImplementation(libs.coroutines.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.okhttp.mockwebserver)
}
