import { noteAdvertPeerHints } from '../discovery/advert_peer_hints.mjs'

/**
 * 解密并验签 advert（`ingestEncryptedAdvert` 别名）。不写 peer hints；写入需 `applyAdvertPeerHints`。Untrusted ingress。
 */
export { ingestEncryptedAdvert as ingestSignedAdvert } from '../discovery/adverts.mjs'

/**
 * 将已验签 advert 的 peer hints 写入本地（apply 侧；与 `ingestSignedAdvert` 分离）。
 * @param {string} verifiedNodeHash 已验签 nodeHash
 * @param {object} body advert body
 * @param {object} [meta] 元数据
 * @returns {void}
 */
export function applyAdvertPeerHints(verifiedNodeHash, body, meta) {
	noteAdvertPeerHints(verifiedNodeHash, body, meta)
}
