import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
	kotlin("jvm") version "2.2.10"
	`java-library`
	`maven-publish`
}

group = "io.github.steve02081504"
version = jsPackageVersion()

// 允许并行构建使用独立输出目录（`-PbuildDirName=build-agent1`），避免多进程争用同一 build/。
layout.buildDirectory.set(file(providers.gradleProperty("buildDirName").getOrElse("build")))

description = "fount federation P2P layer for Android/JVM — Kotlin port of @steve02081504/fount-p2p"

repositories {
	mavenCentral()
	google()
}

dependencies {
	api("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.9.0")
	implementation("com.google.code.gson:gson:2.11.0")
	implementation("org.bouncycastle:bcprov-jdk18on:1.79")

	testImplementation("junit:junit:4.13.2")
}

kotlin {
	compilerOptions {
		jvmTarget.set(JvmTarget.JVM_17)
		freeCompilerArgs.add("-Xjvm-default=all")
	}
}

java {
	withSourcesJar()
	sourceCompatibility = JavaVersion.VERSION_17
	targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<Test>().configureEach {
	useJUnit()
	testLogging {
		events("passed", "skipped", "failed")
	}
}

publishing {
	publications {
		create<MavenPublication>("maven") {
			from(components["java"])
			pom {
				name.set("fount-p2p")
				description.set(project.description)
			}
		}
	}
}

// 版本与 JS 包保持一致，避免两端漂移。
fun jsPackageVersion(): String {
	val packageJson = rootProject.file("../js/package.json")
	if (!packageJson.exists()) return "0.0.0"
	val match = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(packageJson.readText())
	return match?.groupValues?.get(1) ?: "0.0.0"
}
