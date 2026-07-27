package com.couchmic.tv

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

/**
 * CouchMic 首次設定畫面
 *
 * 設計原則：
 * 1. 單 URL 輸入（不做 primary/secondary fallback — 交給 mDNS / Tailscale 處理）
 * 2. 預設值指向 mDNS + 自家 IP，新裝置開箱即用
 * 3. 自動補完 http:// 前綴與 /tv.html 路徑
 * 4. 遙控器友善：方向鍵可切換輸入框與按鈕焦點
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var urlInput: EditText
    private lateinit var connectBtn: MaterialButton
    private lateinit var errorText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        urlInput = findViewById(R.id.urlInput)
        connectBtn = findViewById(R.id.connectBtn)
        errorText = findViewById(R.id.errorText)

        // 預設值：mDNS 優先（朋友家也能用），其次自家 IP
        val saved = Prefs.getServerUrl(this)
        urlInput.setText(saved ?: DEFAULT_URL)
        urlInput.setSelection(urlInput.text.length)

        // IME Go 鍵直接送出
        urlInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                tryConnect()
                true
            } else false
        }

        connectBtn.setOnClickListener { tryConnect() }

        // 預設焦點在輸入框（遙控器按 OK 即進入編輯）
        urlInput.requestFocus()
    }

    private fun tryConnect() {
        val raw = urlInput.text.toString()
        val normalized = UrlValidator.normalize(raw)

        if (!UrlValidator.isValidTvUrl(normalized)) {
            errorText.visibility = View.VISIBLE
            errorText.text = getString(R.string.setup_error_invalid)
            return
        }

        errorText.visibility = View.GONE
        Prefs.setServerUrl(this, normalized)

        // 啟動 MainActivity
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /**
     * 遙控器返回鍵 → 詢問是否退出（避免誤觸）
     */
    override fun onBackPressed() {
        showExitDialog()
    }

    private fun showExitDialog() {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(R.string.setup_exit_title)
            .setMessage(R.string.setup_exit_msg)
            .setPositiveButton(R.string.exit_kiosk_confirm) { _, _ ->
                setResult(Activity.RESULT_CANCELED)
                finishAffinity()
            }
            .setNegativeButton(R.string.exit_kiosk_cancel, null)
            .show()
    }

    companion object {
        // 預設走外網 Funnel（朋友家可連，永久網址）
        // 備援為自家區網 IP（你家用，比較快）
        const val DEFAULT_URL = "https://vibe-nas.taila67710.ts.net/tv.html"
        const val FALLBACK_IP = "http://192.168.31.47:3001/tv.html"
    }
}
