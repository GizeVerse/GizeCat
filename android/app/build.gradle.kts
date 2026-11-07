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

// Release signing: only from android/keystore.properties (gitignored; see keystore.properties.example).
// Without it, release outputs are unsigned. A present but incomplete file is an error, never a
// silent unsigned build.
val keystoreFile: File = rootProject.file("keystore.properties")
val keystoreProps = Properties()
if (keystoreFile.isFile) keystoreFile.inputStream().use { keystoreProps.load(it) }
val signingKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
if (keystoreFile.isFile) {
    val missing = signingKeys.filter { keystoreProps.getProperty(it).isNullOrBlank() }
    require(missing.isEmpty()) { "android/keystore.properties is missing values for: ${missing.joinToString()}" }
}

android {
    namespace = "io.github.gizeverse.gizecat"
    compileSdk = 36

    defaultConfig {
        // Frozen (src/shared/identity.ts androidApplicationId): permanent once published on a store.
        applicationId = "io.github.gizeverse.gizecat"
        minSdk = 29
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion
    }

    signingConfigs {
        if (keystoreFile.isFile) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
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
