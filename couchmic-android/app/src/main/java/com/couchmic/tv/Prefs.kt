package com.couchmic.tv

import android.content.Context

/**
 * CouchMic 本地設定（SharedPreferences）
 *
 * 目前只有一個欄位：伺服器 URL
 * 退出 kiosk 用的 PIN 一律寫死 1234（家用情境，不需要複雜密碼）
 */
object Prefs {
    private const val FILE_NAME = "couchmic_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_EXIT_PIN = "exit_pin"

    const val DEFAULT_EXIT_PIN = "1234"

    fun getServerUrl(ctx: Context): String? =
        ctx.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .getString(KEY_SERVER_URL, null)

    fun setServerUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER_URL, url)
            .apply()
    }

    fun getExitPin(ctx: Context): String =
        ctx.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .getString(KEY_EXIT_PIN, DEFAULT_EXIT_PIN)
            ?: DEFAULT_EXIT_PIN
}
