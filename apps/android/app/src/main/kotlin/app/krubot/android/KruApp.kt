package app.krubot.android

import android.app.Application

class KruApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannel(this)
    }
}
