plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.google.services) apply false
}

import java.util.Properties

// Load local.properties into project extras so MAPS_API_KEY is available to app modules.
val localProperties = Properties()
val localFile = rootProject.file("local.properties")
if (localFile.exists()) {
    localFile.inputStream().use { localProperties.load(it) }
}
extra["MAPS_API_KEY"] = localProperties.getProperty("MAPS_API_KEY")
    ?: (findProperty("MAPS_API_KEY") as String?)
    ?: "YOUR_MAPS_API_KEY"
