import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * The version comes from package.json, as the desktop app's does: CI writes
 * the release tag there before building. The version code is derived from
 * it so an update always installs over the previous one.
 */
val packageJson = groovy.json.JsonSlurper().parse(rootProject.file("package.json")) as Map<*, *>
val appVersion = packageJson["version"] as String
val versionParts = appVersion.split(".").map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
val appVersionCode = (versionParts.getOrElse(0) { 0 } * 1_000_000) + (versionParts.getOrElse(1) { 0 } * 1_000) + versionParts.getOrElse(2) { 0 }

/*
 * Signing: a release build uses the keystore named by KRU_ANDROID_KEYSTORE
 * (with KRU_ANDROID_KEYSTORE_PASSWORD, KRU_ANDROID_KEY_ALIAS and
 * KRU_ANDROID_KEY_PASSWORD) or, without one, the debug key, so the APK
 * from CI still installs on a phone. Android only updates an app over a
 * build signed with the same key, so a fork that ships releases should
 * make a keystore once and keep it in CI's secrets.
 */
val keystorePath = System.getenv("KRU_ANDROID_KEYSTORE")

android {
    namespace = "app.krubot.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.krubot.android"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion
        vectorDrawables.useSupportLibrary = true
    }

    signingConfigs {
        if (!keystorePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("KRU_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KRU_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("KRU_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    // Kru-Bot-<version>.apk, like the desktop installers.
    applicationVariants.all {
        outputs.all {
            (this as? com.android.build.gradle.internal.api.BaseVariantOutputImpl)?.outputFileName = "Kru-Bot-$appVersion${if (buildType.name == "debug") "-debug" else ""}.apk"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.core:core-splashscreen:1.2.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.browser:browser:1.9.0")
    implementation("com.google.android.material:material:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
}
