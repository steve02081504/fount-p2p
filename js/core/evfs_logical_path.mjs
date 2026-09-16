/**
 * @param {string} logicalPath EVFS 逻辑路径
 * @returns {string} 规范化后的相对路径
 */
export function assertSafeEvfsLogicalPath(logicalPath) {
	if (!logicalPath || logicalPath.includes('\0'))
		throw new Error('invalid EVFS path')
	const segments = logicalPath.split(/[/\\]+/).filter(Boolean)
	if (!segments.length) throw new Error('invalid EVFS path')
	for (const segment of segments)
		if (segment === '.' || segment === '..')
			throw new Error('invalid EVFS path traversal')
	return segments.join('/')
}
