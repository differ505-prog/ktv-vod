package com.couchmic.tv

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText

/**
 * CouchMic 主畫面 — WebView 載入 tv.html，進入 kiosk 模式
 *
 * 核心特性：
 * 1. 全螢幕沉浸 (Immersive Sticky) + 防休眠 (FLAG_KEEP_SCREEN_ON)
 * 2. WebView 媒體自動播放 (mediaPlaybackRequiresUserGesture = false)
 * 3. WebView 錯誤自動 retry（網路暫斷自癒）
 * 4. 短按返回 = 沒作用（避免客人誤觸）
 * 5. 長按返回 = 跳出 PIN dialog，輸入正確才退出
 * 6. 支援 Lock Task Mode（device-owner 模式，客人無法跳出 App）
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loadingOverlay: FrameLayout
    private lateinit var errorOverlay: LinearLayout
    private lateinit var errorDetail: TextView
    private lateinit var retryBtn: MaterialButton
    private lateinit var backToSetupBtn: MaterialButton

    private var backPressedAt: Long = 0L
    private var lastFailedUrl: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // 防休眠
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = findViewById(R.id.webView)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        errorOverlay = findViewById(R.id.errorOverlay)
        errorDetail = findViewById(R.id.errorDetail)
        retryBtn = findViewById(R.id.retryBtn)
        backToSetupBtn = findViewById(R.id.backToSetupBtn)

        configureWebView()
        enableImmersiveMode()

        retryBtn.setOnClickListener { retryLoad() }
        backToSetupBtn.setOnClickListener { goToSetup() }

        loadServerUrl()
    }

    /**
     * WebView 設定：JavaScript / DOM Storage / 媒體自動播放 / 內建渲染
     */
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // ★ 關鍵：KTV 連續播歌不能每次都點
            mediaPlaybackRequiresUserGesture = false
            // 影音優化
            allowFileAccess = true
            allowContentAccess = true
            useWideViewPort = true
            loadWithOverviewMode = true
            // 啟用 mixed content（相容某些 cleartext 圖片）
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Cache 設定：提升二次載入速度
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                loadingOverlay.visibility = View.VISIBLE
                errorOverlay.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadingOverlay.visibility = View.GONE
                errorOverlay.visibility = View.GONE
                lastFailedUrl = ""
            }

            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                super.onReceivedError(view, errorCode, description, failingUrl)
                showError("$description (code $errorCode)")
                lastFailedUrl = failingUrl ?: ""
            }
        }
    }

    private fun loadServerUrl() {
        val url = Prefs.getServerUrl(this) ?: SetupActivity.DEFAULT_URL
        webView.loadUrl(url)
    }

    private fun retryLoad() {
        if (lastFailedUrl.isNotEmpty()) {
            webView.loadUrl(lastFailedUrl)
        } else {
            loadServerUrl()
        }
    }

    private fun goToSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
        finish()
    }

    private fun showError(detail: String) {
        loadingOverlay.visibility = View.GONE
        errorOverlay.visibility = View.VISIBLE
        errorDetail.text = detail
    }

    /**
     * 沉浸模式：隱藏狀態列 + 導覽列，遙控器滑動可暫時顯示
     */
    private fun enableImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        enableImmersiveMode()
        // 嘗試進入 Lock Task Mode（僅 device-owner 有效）
        tryEnterLockTask()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Lock Task Mode（kiosk 鎖定）
     *
     * 完整 kiosk 需先執行 ADB：
     *   adb shell dpm set-device-owner com.couchmic.tv/.AdminReceiver
     * 設定後使用者就無法離開 App（Home 鍵失效）
     */
    private fun tryEnterLockTask() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            if (am.isInLockTaskMode) return
            // 需 device-owner 才能完整鎖定；無 device-owner 時
            // 用戶仍可用 Home 鍵離開（graceful degradation）
            try {
                startLockTask()
            } catch (e: SecurityException) {
                // 預期：非 device-owner 時會丟例外，忽略即可
            }
        }
    }

    /**
     * 返回鍵處理：
     * - 短按：第一次 1.5s 內第二次按 = 沒作用（防誤觸）
     * - 長按：跳出 PIN dialog
     */
    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            showExitPinDialog()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val now = System.currentTimeMillis()
        if (now - backPressedAt > 1500) {
            // 第一次按：記錄時間，告訴 user 長按才退出
            backPressedAt = now
            webView.evaluateJavascript(
                "(function(){var t=document.createElement('div');" +
                    "t.textContent='長按返回鍵退出 CouchMic';" +
                    "t.style.cssText='position:fixed;bottom:80px;left:50%;" +
                    "transform:translateX(-50%);background:rgba(0,0,0,0.7);" +
                    "color:#fff;padding:12px 24px;border-radius:8px;z-index:99999;" +
                    "font-size:18px;font-family:sans-serif;';document.body.appendChild(t);" +
                    "setTimeout(function(){t.remove();},2000);})()",
                null
            )
        }
        // 不呼叫 super.onBackPressed() — 阻擋預設退出行為
    }

    private fun showExitPinDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_kiosk_exit, null)
        val title = view.findViewById<TextView>(R.id.dialogTitle)
        val msg = view.findViewById<TextView>(R.id.dialogMsg)
        val pinInput = view.findViewById<TextInputEditText>(R.id.pinInput)

        title.text = getString(R.string.exit_pin_dialog_title)
        msg.text = getString(R.string.exit_pin_dialog_msg)
        pinInput.visibility = View.VISIBLE

        AlertDialog.Builder(this)
            .setView(view)
            .setPositiveButton(R.string.exit_kiosk_confirm) { _, _ ->
                val entered = pinInput.text?.toString() ?: ""
                if (entered == Prefs.getExitPin(this)) {
                    exitCouchMic()
                } else {
                    // 密碼錯誤：搖晃一下輸入框（簡單反饋）
                    pinInput.error = "密碼錯誤"
                }
            }
            .setNegativeButton(R.string.exit_kiosk_cancel, null)
            .show()
    }

    private fun exitCouchMic() {
        // 退出 Lock Task Mode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                if (am.isInLockTaskMode) {
                    stopLockTask()
                }
            } catch (_: Exception) {}
        }
        finishAffinity()
    }
}
