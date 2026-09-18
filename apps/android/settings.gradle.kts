// Kru Bot for Android. Build with `gradle assembleRelease` from this
// directory (ANDROID_HOME set, Java 17 or newer); the APK lands in
// app/build/outputs/apk/release/.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "krubot-android"
include(":app")
