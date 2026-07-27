package com.couchmic.tv

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

/**
 * CouchMic Device Admin Receiver
 *
 * 用途：讓 ADB 設定 device-owner，啟用完整 Lock Task Mode
 *
 * 設定方式（一次性，ADB 連線到電視盒時執行）：
 *   adb shell dpm set-device-owner com.couchmic.tv/.AdminReceiver
 *
 * 設定後：
 * - Home 鍵失效（無法跳出 App）
 * - 任務切換失效（多工鍵失效）
 * - 只有長按返回 + 輸入 PIN 才能退出
 */
class AdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
    }

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        return "退出 CouchMic 需要在 App 內輸入 PIN"
    }
}
