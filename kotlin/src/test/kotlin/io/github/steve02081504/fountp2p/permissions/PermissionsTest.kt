package io.github.steve02081504.fountp2p.permissions

import org.junit.Assert.assertEquals
import org.junit.Test
import java.math.BigInteger

/**
 * 权限位图 / 分层求值器的基础行为测试。
 *
 * JS 侧 `js/permissions/` 暂无对应 `test/pure` 测试，本测试按
 * `bitmask.mjs` / `layered.mjs` / `evaluator.mjs` 的语义补测，覆盖编解码、
 * everyone + 角色覆写与 superuser 旁路。
 */
class PermissionsTest {
	@Test
	fun `permission codec encodes and decodes bit order`() {
		val codec = createPermissionCodec(listOf("read", "write", "admin"))
		val bits = codec.encode(linkedMapOf<String, Any?>("read" to true, "admin" to true, "write" to false))
		assertEquals(BigInteger.valueOf(5), bits)
		assertEquals(
			linkedMapOf<String, Any?>("read" to true, "write" to false, "admin" to true),
			codec.decode(bits),
		)
		assertEquals(BigInteger.ZERO, codec.encode(null))
	}

	@Test
	fun `layered override applies everyone then role overrides`() {
		val evaluator = createLayeredEvaluator(
			linkedMapOf<String, Any?>(
				"order" to listOf("view", "send", "admin"),
				"superuserName" to "admin",
			),
		)
		val roles = linkedMapOf<String, Any?>(
			"@everyone" to linkedMapOf<String, Any?>("permissions" to linkedMapOf<String, Any?>("view" to true)),
			"mod" to linkedMapOf<String, Any?>("permissions" to linkedMapOf<String, Any?>("view" to true, "send" to true)),
		)
		val overrides = linkedMapOf<String, Any?>(
			"chan1" to linkedMapOf<String, Any?>(
				"@everyone" to linkedMapOf<String, Any?>("deny" to linkedMapOf<String, Any?>("view" to true)),
				"mod" to linkedMapOf<String, Any?>("allow" to linkedMapOf<String, Any?>("view" to true)),
			),
		)
		val member = linkedMapOf<String, Any?>("roles" to listOf("mod"))
		val perms = evaluator.calculate(member, roles, "chan1", overrides)
		assertEquals(true, perms["view"])
		assertEquals(true, perms["send"])
		assertEquals(false, perms["admin"])
		assertEquals(true, evaluator.has(member, "send", roles, "chan1", overrides))
	}

	@Test
	fun `superuser bypasses scope overrides`() {
		val evaluator = createLayeredEvaluator(
			linkedMapOf<String, Any?>(
				"order" to listOf("view", "send", "admin"),
				"superuserName" to "admin",
			),
		)
		val roles = linkedMapOf<String, Any?>(
			"root" to linkedMapOf<String, Any?>("permissions" to linkedMapOf<String, Any?>("admin" to true)),
		)
		val overrides = linkedMapOf<String, Any?>(
			"chan1" to linkedMapOf<String, Any?>(
				"@everyone" to linkedMapOf<String, Any?>("deny" to linkedMapOf<String, Any?>("admin" to true)),
			),
		)
		val member = linkedMapOf<String, Any?>("roles" to listOf("root"))
		val perms = evaluator.calculate(member, roles, "chan1", overrides)
		assertEquals(true, perms["admin"])
		assertEquals(true, perms["view"])
	}
}
