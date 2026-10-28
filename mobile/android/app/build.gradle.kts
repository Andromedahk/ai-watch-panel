import java.util.Properties

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
if (file("google-services.json").exists()) { apply(plugin = "com.google.gms.google-services") }
// The optional device-QA variant has its own package and app-scoped trust.
// Generated CA material lives only in the ignored build output directory.
val cloudQaCertificate = providers.gradleProperty("cloudQaCert").orNull
val cloudQaOverlay = layout.buildDirectory.dir("generated/cloudQaOverlay")
val mobileWebBundle = rootProject.layout.projectDirectory.dir("../../dist-mobile")
val mobileWebAssets = layout.buildDirectory.dir("generated/mobileWebAssets")
// Vendor binaries and app credentials are supplied locally after vendor approval.
// No community SDK, invented scene ID or server-side secret is embedded here.
val vivoPushSdk = providers.gradleProperty("vivoPushSdk").orNull
val miPushSdk = providers.gradleProperty("miPushSdk").orNull
val oppoSeedlingSdk = providers.gradleProperty("oppoSeedlingSdk").orNull
val oemConfigFile = rootProject.file(providers.gradleProperty("oemConfigFile").getOrElse("oem-config.properties"))
val vendorOutput = layout.buildDirectory.dir("generated/vendorConfiguration")
val generateVendorConfiguration = tasks.register("generateVendorConfiguration") {
    inputs.file("src/main/AndroidManifest.xml")
    if (oemConfigFile.exists()) inputs.file(oemConfigFile)
    inputs.property("vivo", vivoPushSdk != null); inputs.property("xiaomi", miPushSdk != null); inputs.property("oppo", oppoSeedlingSdk != null)
    outputs.dir(vendorOutput)
    doLast {
        val settings = Properties().apply { if (oemConfigFile.exists()) oemConfigFile.inputStream().use { load(it) } }
        fun value(key: String) = settings.getProperty(key, "").also { check(it.length <= 2048 && !it.contains('\n')) }
        fun xml(value: String) = value.replace("&", "&amp;").replace("<", "&lt;").replace("\"", "&quot;").replace("'", "\\'")
        val resources = linkedMapOf("aiwatch_xiaomi_business" to value("xiaomi.business"), "aiwatch_vivo_scene" to value("vivo.scene"))
        val entries = mutableListOf("<meta-data android:name=\"aiwatch.xiaomi.business\" android:value=\"@string/aiwatch_xiaomi_business\"/>",
            "<meta-data android:name=\"aiwatch.vivo.scene\" android:value=\"@string/aiwatch_vivo_scene\"/>")
        if (value("xiaomi.xmsAppId").isNotBlank()) {
            resources["aiwatch_xiaomi_xms_app_id"] = value("xiaomi.xmsAppId")
            entries += """<meta-data android:name="com.xiaomi.xms.APP_ID" android:value="@string/aiwatch_xiaomi_xms_app_id"/>
                <meta-data android:name="com.xiaomi.xms.BUILD_TYPE_DEBUG" android:value="${'$'}{xmsDebug}"/>"""
        }
        if (vivoPushSdk != null) {
            resources["aiwatch_vivo_app_id"] = value("vivo.appId"); resources["aiwatch_vivo_api_key"] = value("vivo.apiKey")
            entries += """<meta-data android:name="app_id" android:value="@string/aiwatch_vivo_app_id"/>
                <meta-data android:name="api_key" android:value="@string/aiwatch_vivo_api_key"/>
                <receiver android:name="app.aiwatch.mobile.vendor.VivoPushReceiver" android:exported="false"><intent-filter><action android:name="com.vivo.pushclient.action.RECEIVE"/></intent-filter></receiver>"""
        }
        if (miPushSdk != null) {
            resources["aiwatch_xiaomi_app_id"] = value("xiaomi.appId"); resources["aiwatch_xiaomi_app_key"] = value("xiaomi.appKey")
            entries += """<meta-data android:name="aiwatch.xiaomi.appId" android:value="@string/aiwatch_xiaomi_app_id"/>
                <meta-data android:name="aiwatch.xiaomi.appKey" android:value="@string/aiwatch_xiaomi_app_key"/>
                <receiver android:name="app.aiwatch.mobile.vendor.XiaomiPushReceiver" android:exported="true"><intent-filter><action android:name="com.xiaomi.mipush.RECEIVE_MESSAGE"/><action android:name="com.xiaomi.mipush.MESSAGE_ARRIVED"/><action android:name="com.xiaomi.mipush.ERROR"/></intent-filter></receiver>"""
        }
        if (oppoSeedlingSdk != null) {
            for (name in listOf("serviceId", "eventCode", "updateEvent", "endEvent", "inputCountKey", "approvalCountKey", "providerKey", "expiresAtKey")) {
                val key = "aiwatch_oppo_" + name.lowercase()
                resources[key] = value("oppo.$name")
                entries += "<meta-data android:name=\"aiwatch.oppo.$name\" android:value=\"@string/$key\"/>"
            }
            entries += """<provider android:name="app.aiwatch.mobile.vendor.OppoAttentionProvider" android:authorities="${'$'}{applicationId}.attention.cards" android:exported="true"><intent-filter><action android:name="com.oplus.seedling.action.SEEDLING_CARD"/></intent-filter></provider>"""
        }
        val directory = vendorOutput.get().asFile.apply { mkdirs() }
        directory.resolve("AndroidManifest.xml").writeText(file("src/main/AndroidManifest.xml").readText().replace("</application>", entries.joinToString("\n") + "\n</application>"))
        directory.resolve("res/values").mkdirs()
        directory.resolve("res/values/vendor.xml").writeText("<resources>" + resources.entries.joinToString("") { "<string name=\"${it.key}\" translatable=\"false\">${xml(it.value)}</string>" } + "</resources>")
    }
}
val syncMobileWebAssets = tasks.register<Sync>("syncMobileWebAssets") {
    from(mobileWebBundle)
    into(mobileWebAssets.map { it.dir("mobile") })
    doFirst { check(mobileWebBundle.file("index.html").asFile.isFile) { "Build the shared mobile web bundle first: npm run build:mobile-web" } }
}
val generateCloudQaOverlay = if (cloudQaCertificate != null) tasks.register("generateCloudQaOverlay") {
    inputs.file(file(cloudQaCertificate))
    outputs.dir(cloudQaOverlay)
    doLast {
        val overlay = cloudQaOverlay.get().asFile
        val raw = overlay.resolve("res/raw").apply { mkdirs() }
        val xml = overlay.resolve("res/xml").apply { mkdirs() }
        val java = overlay.resolve("java/app/aiwatch/mobile").apply { mkdirs() }
        file(cloudQaCertificate).copyTo(raw.resolve("cloud_qa_ca.pem"), overwrite = true)
        xml.resolve("cloud_qa_network_security.xml").writeText("""
            <network-security-config>
                <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
                <domain-config cleartextTrafficPermitted="false">
                    <domain includeSubdomains="false">localhost</domain>
                    <trust-anchors><certificates src="@raw/cloud_qa_ca" /></trust-anchors>
                </domain-config>
            </network-security-config>
        """.trimIndent())
        overlay.resolve("AndroidManifest.xml").writeText("""
            <manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
                <application android:label="AI Watch QA" android:networkSecurityConfig="@xml/cloud_qa_network_security" tools:replace="android:label">
                    <activity android:name="app.aiwatch.mobile.CloudQaThemeActivity" android:exported="true" />
                </application>
            </manifest>
        """.trimIndent())
        java.resolve("CloudQaThemeActivity.java").writeText("""
            package app.aiwatch.mobile;
            public final class CloudQaThemeActivity extends android.app.Activity {
                @Override public void onCreate(android.os.Bundle state) {
                    super.onCreate(state);
                    if (android.os.Build.VERSION.SDK_INT >= 31) {
                        getSystemService(android.app.UiModeManager.class).setApplicationNightMode(
                            getIntent().getBooleanExtra("night", false)
                            ? android.app.UiModeManager.MODE_NIGHT_YES : android.app.UiModeManager.MODE_NIGHT_NO);
                    }
                    finish();
                }
            }
        """.trimIndent())
    }
} else null
android {
    namespace = "app.aiwatch.mobile"
    compileSdk = 36
    defaultConfig { applicationId = "app.aiwatch.mobile"; minSdk = 26; targetSdk = 36; versionCode = 1; versionName = "0.1.0"; manifestPlaceholders["xmsDebug"] = "false" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets.getByName("main").assets.srcDir(mobileWebAssets)
    sourceSets.getByName("main") {
        manifest.srcFile(vendorOutput.map { it.file("AndroidManifest.xml") })
        res.srcDir(vendorOutput.map { it.dir("res") })
        if (vivoPushSdk != null) java.srcDir("src/vivo/java")
        if (miPushSdk != null) java.srcDir("src/xiaomi/java")
        if (oppoSeedlingSdk != null) java.srcDir("src/oppo/java")
    }
    buildTypes {
        getByName("debug") { manifestPlaceholders["xmsDebug"] = "true" }
        release { isMinifyEnabled = false }
        if (cloudQaCertificate != null) create("qa") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".qa"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "debug"
        }
    }
    if (cloudQaCertificate != null) sourceSets.getByName("qa") {
        manifest.srcFile(cloudQaOverlay.map { it.file("AndroidManifest.xml") })
        res.srcDir(cloudQaOverlay.map { it.dir("res") })
        java.srcDir(cloudQaOverlay.map { it.dir("java") })
    }
}
if (generateCloudQaOverlay != null) tasks.configureEach {
    if (name == "preQaBuild") dependsOn(generateCloudQaOverlay)
}
tasks.configureEach { if (name == "preBuild") dependsOn(syncMobileWebAssets, generateVendorConfiguration) }
dependencies {
    if (vivoPushSdk != null) implementation(files(rootProject.file(vivoPushSdk)))
    if (miPushSdk != null) implementation(files(rootProject.file(miPushSdk)))
    if (oppoSeedlingSdk != null) implementation(files(rootProject.file(oppoSeedlingSdk)))
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation(platform("com.google.firebase:firebase-bom:34.6.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
