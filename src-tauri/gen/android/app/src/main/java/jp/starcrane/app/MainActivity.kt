package jp.starcrane.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File

private class AndroidApkInstallerBridge(private val activity: Activity) {
  @JavascriptInterface
  fun canInstallPackages(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.packageManager.canRequestPackageInstalls()
    } else {
      true
    }
  }

  @JavascriptInterface
  fun installApk(filePath: String): String {
    return try {
      val updatesDir = File(activity.cacheDir, "updates").canonicalFile
      val apkFile = File(filePath).canonicalFile
      val prefix = updatesDir.path.let {
        if (it.endsWith(File.separator)) it else "$it${File.separator}"
      }
      if (!apkFile.path.startsWith(prefix) ||
        !apkFile.name.endsWith(".apk", ignoreCase = true) ||
        !apkFile.isFile
      ) {
        return "ERR:Invalid APK path"
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !activity.packageManager.canRequestPackageInstalls()
      ) {
        val permIntent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${activity.packageName}"),
        ).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(permIntent)
        return "NEED_PERMISSION"
      }

      val uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        apkFile,
      )
      val installIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(installIntent)
      "OK"
    } catch (ex: Exception) {
      "ERR:${ex.message ?: "Unknown error"}"
    }
  }
}

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(AndroidApkInstallerBridge(this), "StarCraneAndroidUpdater")
  }
}
