plugins {
    id("com.android.application") version "8.9.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("com.google.gms.google-services") version "4.4.3" apply false
}
allprojects {
    layout.buildDirectory.set(rootProject.layout.projectDirectory.dir("../../.local/qa/cloud-sync/android/${project.name}"))
}
