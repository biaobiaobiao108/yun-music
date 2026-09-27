export function reorderCustomSourceIds(sourceIds: string[], sourceId: string, targetId: string, afterTarget: boolean): string[] | null {
  if (!sourceId || sourceId === targetId) return null
  const orderedIds = [...sourceIds]
  const sourceIndex = orderedIds.indexOf(sourceId)
  if (sourceIndex < 0 || !orderedIds.includes(targetId)) return null

  const [movingId] = orderedIds.splice(sourceIndex, 1)
  const targetIndex = orderedIds.indexOf(targetId)
  orderedIds.splice(targetIndex + (afterTarget ? 1 : 0), 0, movingId)
  return orderedIds
}
