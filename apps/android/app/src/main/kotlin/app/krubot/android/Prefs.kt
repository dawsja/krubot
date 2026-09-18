package app.krubot.android

import android.content.Context
import androidx.core.content.edit

/** What the app remembers: the server it is pointed at. */
object Prefs {
    private const val FILE = "kru"
    private const val SERVER = "server"

    fun server(context: Context): String? = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(SERVER, null)

    fun setServer(context: Context, origin: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putString(SERVER, origin) }
    }
}
