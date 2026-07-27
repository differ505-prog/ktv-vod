package com.couchmic.tv

/**
 * CouchMic 伺服器 URL 驗證器
 *
 * 規則：
 * 1. 必須是 http:// 或 https:// 開頭
 * 2. 必須指向 /tv.html（避免載入 mobile.html）
 * 3. host 不可為空
 *
 * 不做網路探測（probe）— 連線狀態交給 WebView 內部處理。
 */
object UrlValidator {

    private val pattern = Regex(
        "^https?://[\\w.\\-:]+(:\\d+)?(/[\\w./?=&%\\-]+)?$"
    )

    fun isValidTvUrl(url: String): Boolean {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) return false
        if (!pattern.matches(trimmed)) return false
        // 必須含 /tv.html — WebView 才能正確載入電視端頁面
        if (!trimmed.endsWith("/tv.html") && !trimmed.contains("/tv.html?")) return false
        return true
    }

    /**
     * 自動補完 URL：使用者輸入 "192.168.1.50:3001" 也能 work
     */
    fun normalize(input: String): String {
        var s = input.trim()
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            s = "http://$s"
        }
        // 若沒指定 path，預設載入 /tv.html
        if (!s.contains("/tv.html")) {
            s = s.trimEnd('/') + "/tv.html"
        }
        return s
    }
}
