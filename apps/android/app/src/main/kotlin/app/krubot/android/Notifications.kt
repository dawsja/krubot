package app.krubot.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/*
 * Notifications on the phone. The WebView has no Web Push, so the web app
 * asks for one through the bridge when the API announces that a bot
 * finished a job for you or needs your input (a `notify` live event).
 * They arrive while Kru Bot is open or in the background.
 */
object Notifications {
    const val CHANNEL = "bots"
    const val EXTRA_URL = "app.krubot.android.url"

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL, context.getString(R.string.notifications_channel), NotificationManager.IMPORTANCE_HIGH)
        channel.description = context.getString(R.string.notifications_channel_description)
        manager.createNotificationChannel(channel)
    }

    /** "granted", "denied" or "prompt", as the web app's notifications card shows it. */
    fun state(context: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                return if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
            }
            return "prompt"
        }
        return if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
    }

    fun show(context: Context, title: String, body: String, url: String, tag: String) {
        if (state(context) != "granted") return
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(EXTRA_URL, url)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            // One notification per conversation, the newest replacing the last.
            NotificationManagerCompat.from(context).notify(tag, 0, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }
}
