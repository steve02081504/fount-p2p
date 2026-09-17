package io.github.steve02081504.fountp2p.discovery.bt

import java.io.File

/**
 * 已连接的 GATT 会话（central 侧）。
 */
interface BleGattConnection {
	/**
	 * @param bytes 出站载荷
	 */
	suspend fun write(bytes: ByteArray)

	/**
	 * @param callback notify 回调
	 * @return 取消订阅
	 */
	fun onNotify(callback: (ByteArray) -> Unit): () -> Unit

	/** 关闭连接。 */
	suspend fun close()
}

/**
 * 蓝牙运行时抽象（Android/JVM 无 `@stoprocent/noble` 等 native 依赖；由宿主注入）。
 */
interface BluetoothProvider {
	/**
	 * @param timeoutMs 超时
	 * @return BT 栈是否可用
	 */
	suspend fun probe(timeoutMs: Long): Boolean

	/** @return noble central 运行时（宿主自定义类型） */
	suspend fun loadNoble(): Any?

	/** @return bleno peripheral 运行时（宿主自定义类型） */
	suspend fun loadBleno(): Any?

	/**
	 * 经 GATT 发送信令。
	 * @param peripheralId 目标 peripheral
	 * @param bytes 载荷
	 * @return 是否发出
	 */
	suspend fun sendSignal(peripheralId: String, bytes: ByteArray): Boolean

	/**
	 * 连接到目标 peripheral 的 GATT 数据服务。
	 * @param peripheralId 目标 peripheral
	 * @return 连接；不支持时为 null
	 */
	suspend fun connectGatt(peripheralId: String): BleGattConnection? = null
}

private var bluetoothProvider: BluetoothProvider? = null

/** @param provider 蓝牙运行时 provider */
fun setBluetoothProvider(provider: BluetoothProvider?) {
	bluetoothProvider = provider
}

/** @return 当前蓝牙运行时 provider */
fun getBluetoothProvider(): BluetoothProvider? = bluetoothProvider

/**
 * 解析 Bluetooth 角色（scan / dual）。
 *
 * Win32 默认 scan（单适配器 central+peripheral 常冲突）；其他平台 dual。
 * @return 生效角色
 */
fun resolveBtRole(): String =
	if (System.getProperty("os.name")?.lowercase()?.contains("win") == true) "scan" else "dual"

/**
 * 廉价硬件探测：明确无适配器时跳过 native 加载。
 * @return true=有迹象，false=明确无，null=未知
 */
fun probeBluetoothHardware(): Boolean? {
	val os = System.getProperty("os.name")?.lowercase() ?: ""
	if (os.contains("linux")) {
		return try {
			val dir = File("/sys/class/bluetooth")
			if (!dir.exists()) false
			else dir.listFiles()?.any { !it.name.startsWith(".") } ?: false
		}
		catch (_: Exception) {
			false
		}
	}
	return null
}

/**
 * 等待 BLE 运行时 poweredOn。
 * @param runtime 蓝牙运行时包装
 * @param timeout 超时毫秒
 */
@JvmOverloads
suspend fun waitPoweredOn(runtime: BluetoothRuntime, timeout: Long? = null) {
	val async = runtime.waitForPoweredOnAsync
	if (async != null) {
		async(timeout)
		return
	}
	val sync = runtime.waitForPoweredOn
	if (sync != null) {
		sync(timeout)
		return
	}
	throw IllegalArgumentException("p2p: bluetooth runtime missing waitForPoweredOn(Async)")
}

/** 兼容 noble/bleno v1/v2 的 poweredOn 等待包装。 */
class BluetoothRuntime(
	val waitForPoweredOnAsync: (suspend (Long?) -> Unit)? = null,
	val waitForPoweredOn: (suspend (Long?) -> Unit)? = null,
) {
	/**
	 * @param timeout 超时毫秒
	 */
	suspend fun waitPoweredOn(timeout: Long? = null) = io.github.steve02081504.fountp2p.discovery.bt.waitPoweredOn(this, timeout)
}

private var cachedRuntimeOk: Boolean? = null

/**
 * 进程内 BT 可用性探测（缓存）。
 * @param timeoutMs waitPoweredOn 超时
 * @return 可用为 true
 */
@JvmOverloads
suspend fun canUseBluetoothRuntime(timeoutMs: Long = 3000): Boolean {
	cachedRuntimeOk?.let { return it }
	if (probeBluetoothHardware() == false) {
		cachedRuntimeOk = false
		return false
	}
	val provider = bluetoothProvider
	val ok = try {
		provider?.probe(timeoutMs) ?: false
	}
	catch (_: Exception) {
		false
	}
	cachedRuntimeOk = ok
	return ok
}

/**
 * 加载 Noble BLE central。
 * @return noble 运行时
 */
suspend fun loadNoble(): Any? =
	bluetoothProvider?.loadNoble() ?: throw IllegalStateException("p2p: no bluetooth adapter")

/**
 * 加载 Bleno BLE peripheral。
 * @return bleno 运行时
 */
suspend fun loadBleno(): Any? =
	bluetoothProvider?.loadBleno() ?: throw IllegalStateException("p2p: no bluetooth adapter")

/** 测试用：清空可用性缓存。 */
fun resetBluetoothRuntimeCacheForTests() {
	cachedRuntimeOk = null
}
