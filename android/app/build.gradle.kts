// GizeCat for Android tablets: a native WebView that serves the production web bundle (out/web,
// copied into src/main/assets by scripts/build-web-app.mjs). Guide: android/README.md.
import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// Version: package.json is the single source. versionCode = MAJOR*10000 + MINOR*100 + PATCH, so it
// always increases as long as MINOR and PATCH stay below 100 (1.4.0 -> 10400).
val repoRoot: File = rootDir.parentFile
val appVersion: String = ((JsonSlurper().parse(repoRoot.resolve("package.json")) as Map<*, *>)["version"] as? String)
    ?: error("package.json has no version")
val versionParts: List<Int> = Regex("""(\d+)\.(\d+)\.(\d+)""").matchEntire(appVersion)?.groupValues?.drop(1)?.map { it.toInt() }
    ?: error("package.json version must be MAJOR.MINOR.PATCH, got \"$appVersion\"")
val (appMajor, appMinor, appPatch) = versionParts
require(appMinor < 100 && appPatch < 100) { "versionCode needs MINOR and PATCH below 100, got $appVersion" }
val appVersionCode: Int = appMajor * 10000 + appMinor * 100 + appPatch

// The Android app's own version (android/version.properties, 1.4.1): package.json stays the desktop
// and web version, so a release that updates only Android does not claim the unchanged Windows and
// macOS builds are new. The code may never be lower than package.json's formula would give.
val androidVersionFile: File = rootProject.file("version.properties")
val androidVersionProps: Properties = Properties().apply {
    require(androidVersionFile.isFile) { "android/version.properties is missing" }
    androidVersionFile.inputStream().use { load(it) }
}
val androidVersionName: String = androidVersionProps.getProperty("versionName")?.trim().orEmpty()
    .also { require(Regex("""\d+\.\d+\.\d+""").matches(it)) { "android/version.properties: versionName must be MAJOR.MINOR.PATCH, got \"$it\"" } }
val androidVersionCode: Int = androidVersionProps.getProperty("versionCode")?.trim()?.toIntOrNull()
    ?.also { require(it >= appVersionCode) { "android/version.properties: versionCode $it is lower than package.json's ($appVersionCode)" } }
    ?: error("android/version.properties: versionCode must be a whole number")

// Preview builds (docs/platforms/android-overlay.md): -PgizecatPreview=N (1..99) names a build that
// is not the release, so it can never be mistaken for it: versionName gets "-overlay.N" (every build
// type), and the sideload TRIAL build's versionCode becomes androidVersionCode + N, so it installs as an
// update over an earlier trial APK of the same version (same applicationId, same debug key). The
// release build's versionCode is left alone: a real release must never be older than a preview.
val previewNumber: Int? = providers.gradleProperty("gizecatPreview").orNull?.let { raw ->
    raw.toIntOrNull()?.takeIf { it in 1..99 } ?: error("-PgizecatPreview must be a whole number from 1 to 99, got \"$raw\"")
}

// Release signing (owner procedure: docs/platforms/android-signing.md). The first source that holds
// anything wins:
//   1. The environment, for CI: the four variables below. A blank value counts as unset, because a
//      GitHub secret that does not exist reaches the job as an empty string.
//   2. android/keystore.properties (gitignored; see keystore.properties.example), for local builds.
//   3. Nothing: the release APK and AAB are unsigned.
// A partial source stops the build, never a silent unsigned one. Messages name what is missing and
// never print a value. APK and AAB come from the one release build type, so they share this key.
val signingEnvNames: Map<String, String> = mapOf(
    "storeFile" to "ANDROID_KEYSTORE_FILE",
    "storePassword" to "ANDROID_KEYSTORE_PASSWORD",
    "keyAlias" to "ANDROID_KEY_ALIAS",
    "keyPassword" to "ANDROID_KEY_PASSWORD",
)
val signingEnv: Map<String, String> = signingEnvNames
    .mapValues { (_, name) -> providers.environmentVariable(name).orNull.orEmpty() }
    .filterValues { it.isNotBlank() }
val keystoreFile: File = rootProject.file("keystore.properties")

/** storeFile, storePassword, keyAlias and keyPassword of the release key, or null when none is configured. */
val releaseKey: Map<String, String>? = when {
    signingEnv.isNotEmpty() -> {
        val missing = signingEnvNames.filterKeys { it !in signingEnv }.values
        require(missing.isEmpty()) {
            "Release signing from the environment is incomplete. Missing: ${missing.joinToString()}. " +
                "Set all of ${signingEnvNames.values.joinToString()}, or none of them."
        }
        signingEnv
    }
    keystoreFile.isFile -> {
        val props = Properties().apply { keystoreFile.inputStream().use { load(it) } }
        val missing = signingEnvNames.keys.filter { props.getProperty(it).isNullOrBlank() }
        require(missing.isEmpty()) { "android/keystore.properties is missing values for: ${missing.joinToString()}" }
        signingEnvNames.keys.associateWith { props.getProperty(it) }
    }
    else -> null
}
releaseKey?.let { key ->
    require(file(key.getValue("storeFile")).isFile) {
        "Release signing: the keystore file does not exist (check ANDROID_KEYSTORE_FILE, or storeFile in android/keystore.properties)."
    }
}

android {
    namespace = "io.github.gizeverse.gizecat"
    compileSdk = 36

    defaultConfig {
        // Frozen (src/shared/identity.ts androidApplicationId): permanent once published on a store.
        applicationId = "io.github.gizeverse.gizecat"
        minSdk = 29
        targetSdk = 36
        versionCode = androidVersionCode
        versionName = androidVersionName
        versionNameSuffix = previewNumber?.let { "-overlay.$it" } ?: ""
    }

    signingConfigs {
        releaseKey?.let { key ->
            create("release") {
                storeFile = file(key.getValue("storeFile"))
                storePassword = key.getValue("storePassword")
                keyAlias = key.getValue("keyAlias")
                keyPassword = key.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
            // No META-INF/version-control-info.textproto (the git state of the build machine), so
            // the same sources give the same outputs. The trial build inherits this through initWith.
            vcsInfo { include = false }
        }
        // Sideload trials only, never for distribution: release code signed with the SDK debug
        // keystore, its own applicationId (and so its own cat), labelled "GizeCat (trial)".
        create("trial") {
            initWith(getByName("release"))
            applicationIdSuffix = ".trial"
            versionNameSuffix = "-trial"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    dependenciesInfo {
        includeInApk = false
    }
}

// The trial build of a preview installs over an earlier trial APK (see previewNumber above).
androidComponents {
    onVariants(selector().withBuildType("trial")) { variant ->
        previewNumber?.let { n -> variant.outputs.forEach { it.versionCode.set(androidVersionCode + n) } }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.core:core:1.17.0")
}

// The web bundle is generated (gitignored): fail early with the fix instead of packaging an app
// without its page.
val webAssetsIndex: File = file("src/main/assets/index.html")
val checkWebAssets = tasks.register("checkWebAssets") {
    val index = webAssetsIndex
    doLast {
        if (!index.isFile) {
            throw GradleException("android/app/src/main/assets/index.html is missing: run node scripts/build-web-app.mjs first")
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(checkWebAssets) }
