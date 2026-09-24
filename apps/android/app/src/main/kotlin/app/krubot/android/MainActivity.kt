package app.krubot.android

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.graphics.toColorInt
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.doAfterTextChanged
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import app.krubot.android.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject
import kotlin.math.max

/*
 * Kru Bot for Android. Like the desktop app, the app is the web app
 * itself: once Connect has found your Kru Bot, this activity shows its
 * pages in a WebView, and everything after sign-in is the same app as in a
 * browser, laid out for a phone. What the shell adds is what a page can't
 * do on its own here: notifications, file uploads and downloads, links
 * that open outside, sign-ins that come back, and the bars around the page.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val web get() = binding.web

    /** The server the WebView is pointed at, once Connect has found one. */
    var server: String? = null
        private set
    private var connecting = false
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        pendingFiles?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        pendingFiles = null
    }
    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // The web app's notifications card reads the state again on this event.
        web.evaluateJavascript("window.dispatchEvent(new Event('kru:notifications'))", null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyInsets()
        setupWebView()
        setupConnect()

        onBackPressedDispatcher.addCallback(this) {
            when {
                binding.connect.visibility == View.VISIBLE && server != null && !connecting -> showServer(null)
                web.visibility == View.VISIBLE && web.canGoBack() -> web.goBack()
                else -> {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }

        server = Prefs.server(this)
        if (finishSignIn(intent)) return
        val target = intent?.getStringExtra(Notifications.EXTRA_URL)
        if (server != null) showServer(target ?: "/app") else showConnect(null, null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (finishSignIn(intent)) return
        // A tapped notification: the conversation it came from.
        val url = intent.getStringExtra(Notifications.EXTRA_URL) ?: return
        if (server != null) showServer(url)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // ---------- the bars around the page ----------

    /** Status bar, gesture bar and keyboard become padding, so the page lays out in what is left. */
    private fun applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    /** The page's own background behind the bars, and icons that read on it. */
    fun applyTheme(background: String?, dark: Boolean) {
        val color = try {
            background?.trim()?.toColorInt()
        } catch (_: IllegalArgumentException) {
            null
        }
        if (color != null) binding.root.setBackgroundColor(color)
        val controller = WindowCompat.getInsetsController(window, binding.root)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }

    private fun resetTheme() {
        binding.root.setBackgroundColor(ContextCompat.getColor(this, R.color.background))
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val controller = WindowCompat.getInsetsController(window, binding.root)
        controller.isAppearanceLightStatusBars = !night
        controller.isAppearanceLightNavigationBars = !night
    }

    // ---------- Connect ----------

    private fun setupConnect() {
        binding.address.doAfterTextChanged { binding.field.error = null }
        binding.address.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) {
                connect(binding.address.text?.toString())
                true
            } else {
                false
            }
        }
        binding.submit.setOnClickListener { connect(binding.address.text?.toString()) }
        binding.back.setOnClickListener { showServer(null) }
    }

    fun showConnect(prefill: String?, error: String?) {
        resetTheme()
        web.visibility = View.GONE
        binding.progress.visibility = View.GONE
        binding.connect.visibility = View.VISIBLE
        if (prefill != null) binding.address.setText(prefill)
        binding.field.error = error
        binding.back.visibility = if (server != null && web.url != null) View.VISIBLE else View.GONE
        binding.back.text = getString(R.string.connect_back, server ?: "")
        binding.address.requestFocus()
        binding.address.setSelection(binding.address.text?.length ?: 0)
    }

    private fun setBusy(busy: Boolean) {
        connecting = busy
        binding.submit.isEnabled = !busy
        binding.submit.text = getString(if (busy) R.string.connect_busy else R.string.connect_button)
        binding.address.isEnabled = !busy
    }

    private fun connect(input: String?) {
        if (connecting) return
        val origins = try {
            ServerUrl.candidates(input)
        } catch (failure: ServerUrl.Invalid) {
            binding.field.error = getString(
                when (failure.reason) {
                    ServerUrl.Reason.EMPTY -> R.string.connect_error_empty
                    ServerUrl.Reason.INVALID -> R.string.connect_error_invalid
                    ServerUrl.Reason.SCHEME -> R.string.connect_error_scheme
                    ServerUrl.Reason.CREDENTIALS -> R.string.connect_error_credentials
                },
            )
            return
        }
        setBusy(true)
        binding.field.error = null
        lifecycleScope.launch {
            val found = try {
                origins.firstOrNull { origin -> isKruBot(origin) }
            } catch (_: Exception) {
                null
            }
            setBusy(false)
            if (found == null) {
                binding.field.error = getString(R.string.connect_no_answer)
                return@launch
            }
            if (found != server) {
                // A different Kru Bot: its own sign-in, not the last one's.
                CookieManager.getInstance().removeAllCookies(null)
                web.clearHistory()
            }
            server = found
            Prefs.setServer(this@MainActivity, found)
            showServer("/login")
        }
    }

    /** Asks `origin` for Kru Bot's health check; true only for a Kru Bot that answers. */
    private suspend fun isKruBot(origin: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val connection = URL("$origin/api/health").openConnection() as HttpURLConnection
            connection.connectTimeout = PROBE_TIMEOUT_MS
            connection.readTimeout = PROBE_TIMEOUT_MS
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.useCaches = false
            try {
                if (connection.responseCode !in 200..299) return@withContext false
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                JSONObject(body).optBoolean("ok", false)
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            false
        }
    }

    // ---------- your Kru Bot ----------

    fun showServer(path: String?) {
        val origin = server ?: return
        binding.connect.visibility = View.GONE
        web.visibility = View.VISIBLE
        if (path != null) web.loadUrl(Uri.parse(origin).buildUpon().encodedPath(null).build().toString().trimEnd('/') + path)
    }

    // ---------- signing in with the provider ----------

    /**
     * The provider's sign-in runs in the phone's browser: a WebView can't use
     * passkeys, and many providers refuse to sign in inside one. The browser
     * gets only a hash of a verifier kept here; the API sends back a one-time
     * code that is good only with it (see apps/api/src/mobile-sign-in.ts).
     */
    fun startSignIn(next: String?) {
        val origin = server ?: return
        val verifier = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        Prefs.setPendingSignIn(this, verifier, next?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/app")
        openOutside("$origin/api/mobile-sign-in/start?challenge=$challenge")
    }

    /** `krubot://sign-in?code=…` from the browser: the code and the verifier become this app's session. */
    private fun finishSignIn(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != "krubot" || data.host != "sign-in") return false
        if (server == null) {
            showConnect(null, null)
            return true
        }
        val pending = Prefs.takePendingSignIn(this)
        val code = data.getQueryParameter("code")
        if (pending == null || code == null) {
            showServer("/login?error=oidc")
            return true
        }
        val (verifier, next) = pending
        showServer(
            "/api/mobile-sign-in/redeem?" + Uri.Builder()
                .appendQueryParameter("code", code)
                .appendQueryParameter("verifier", verifier)
                .appendQueryParameter("next", next)
                .build().encodedQuery,
        )
        return true
    }

    /** Runs `action` only when the page asking belongs to the server; the bridge calls it off the UI thread. */
    fun fromTrustedPage(action: MainActivity.() -> Unit) {
        runOnUiThread {
            if (ServerUrl.sameOrigin(web.url, server)) action()
        }
    }

    fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (Notifications.state(this) == "prompt") {
                notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        // Turned off in the system, or an older Android: the app's notification settings.
        startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName))
    }

    /** Links to anywhere but your Kru Bot open in the phone's browser, never in the app. */
    fun openOutside(url: String) {
        val uri = url.toUri()
        try {
            if (uri.scheme == "http" || uri.scheme == "https") CustomTabsIntent.Builder().build().launchUrl(this, uri)
            else startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            // target=_blank and window.open reach onCreateWindow below.
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // An app, not a web page: no pinch zoom (the system font size still applies).
            setSupportZoom(false)
            builtInZoomControls = false
            userAgentString = "$userAgentString KruBot/${BuildConfig.VERSION_NAME} (Android)"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.addJavascriptInterface(KruBridge(this), "kruMobile")
        web.setBackgroundColor(Color.TRANSPARENT)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val origin = server
                val scheme = url.scheme?.lowercase()
                if (scheme != "http" && scheme != "https") {
                    openOutside(url.toString())
                    return true
                }
                // The localhost end of an MCP sign-in (see MCP_LOOPBACK_CALLBACK in
                // packages/shared): finished on the server's own callback, as the desktop does.
                if (isLoopbackCallback(url) && origin != null) {
                    view.loadUrl("$origin/api/mcp-servers/oauth/callback?${url.encodedQuery.orEmpty()}")
                    return true
                }
                // Everything else loads here: your Kru Bot's pages, and a sign-in the page
                // started (Composio, an MCP server's OAuth) so it can come back with the
                // session. Links that open a new window go to the browser (onCreateWindow).
                return false
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                binding.progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                binding.progress.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                val origin = server ?: return
                // The server is down or gone: back to Connect, with the address filled in.
                if (request.isForMainFrame && ServerUrl.sameOrigin(request.url.toString(), origin)) {
                    showConnect(origin, getString(R.string.connect_unreachable, origin, error.description))
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                binding.progress.setProgressCompat(newProgress, true)
            }

            /**
             * A link with target=_blank, or window.open: your Kru Bot's own pages (a
             * file, an attachment) open here; anything else in the phone's browser.
             * The URL is caught from the first navigation of a throwaway WebView.
             */
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                val popup = WebView(view.context)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(popupView: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (ServerUrl.sameOrigin(url, server)) web.loadUrl(url) else if (url != "about:blank") openOutside(url)
                        popupView.destroy()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pendingFiles?.onReceiveValue(null)
                pendingFiles = callback
                return try {
                    pickFiles.launch(params.createIntent().addCategory(Intent.CATEGORY_OPENABLE))
                    true
                } catch (_: ActivityNotFoundException) {
                    pendingFiles = null
                    false
                }
            }
        }

        // Attachments: the phone's download manager, with the session so the API answers.
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            if (!ServerUrl.sameOrigin(url, server)) {
                openOutside(url)
                return@setDownloadListener
            }
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(url.toUri()).apply {
                setMimeType(mimeType)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                addRequestHeader("User-Agent", userAgent)
                setTitle(name)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            }
            getSystemService(DownloadManager::class.java)?.enqueue(request)
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show()
        }
    }

    private fun isLoopbackCallback(url: Uri): Boolean {
        val host = url.host?.lowercase()
        return (host == "localhost" || host == "127.0.0.1" || host == "[::1]") && url.port == LOOPBACK_PORT && url.path == "/callback" && url.getQueryParameter("state") != null
    }

    companion object {
        /** How long a server gets to answer the health check on Connect. */
        private const val PROBE_TIMEOUT_MS = 8_000

        /** Kept in step with MCP_LOOPBACK_PORT in packages/shared. */
        private const val LOOPBACK_PORT = 47651
    }
}
