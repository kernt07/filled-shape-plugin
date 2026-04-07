import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ChangeEvent } from 'react'
import {
  useActionTrigger,
  useConfig,
  useEditorPanelConfig,
  useElementColumns,
  useElementData,
  useInteraction,
  usePlugin,
  usePluginStyle,
  useVariable,
} from '@sigmacomputing/plugin'

type ChartRow = {
  label: string
  value: number
  rawValue: unknown
  rawDisplay: string
}

type ShapeGlyphProps = {
  shapeSrc: string
  value: number
  outlineColor: string
  fillColor: string
  orientation: 'row' | 'column'
  rotationMode: string
}

function readConfigId(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string' || typeof input === 'number') return String(input)
  if (Array.isArray(input)) return readConfigId(input[0])
  if (typeof input === 'object') {
    const candidate = input as Record<string, unknown>
    const first = candidate.id ?? candidate.columnId ?? candidate.colId ?? candidate.elementId ?? candidate.value
    return readConfigId(first)
  }
  return ''
}

function readColorConfig(input: unknown, fallback: string): string {
  if (input == null) return fallback
  if (typeof input === 'string') {
    const trimmed = input.trim()
    return trimmed || fallback
  }
  if (typeof input === 'object') {
    const candidate = input as Record<string, unknown>
    const value =
      candidate.value ??
      candidate.hex ??
      candidate.color ??
      candidate.defaultValue ??
      candidate.selectedValue
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return fallback
}

function coercePercent(input: unknown): number {
  const parsed = Number(input)
  if (!Number.isFinite(parsed)) return 0
  // Sigma measures are often ratios (0-1); convert ratios to percentages.
  const normalized = parsed * 100
  if (normalized < 0) return 0
  if (normalized > 100) return 100
  return normalized
}

function selectionTypeFor(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (value instanceof Date) return 'datetime'
  return 'text'
}

function formatRawValue(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input === 'number') return Number.isFinite(input) ? String(input) : ''
  if (typeof input === 'boolean') return input ? 'true' : 'false'
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>
    const preferred =
      record.formattedValue ??
      record.formatted ??
      record.displayValue ??
      record.label ??
      record.text ??
      record.value
    if (preferred != null) return String(preferred)
  }
  return String(input)
}

function cssColorToRgba(input: string): [number, number, number, number] {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return [255, 255, 255, 255]
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000000'
  ctx.fillStyle = input
  ctx.fillRect(0, 0, 1, 1)
  const pixel = ctx.getImageData(0, 0, 1, 1).data
  return [pixel[0], pixel[1], pixel[2], pixel[3]]
}

function normalizeQuarterTurns(turns: number): number {
  const normalized = turns % 4
  return normalized < 0 ? normalized + 4 : normalized
}

function ShapeGlyph({
  shapeSrc,
  value,
  outlineColor,
  fillColor,
  orientation,
  rotationMode,
}: ShapeGlyphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!shapeSrc || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const width = canvas.width
      const height = canvas.height
      ctx.clearRect(0, 0, width, height)
      const alphaThreshold = 12

      // Trim source image to visible (non-transparent) bounds so layout gap reflects icon width.
      const srcCanvas = document.createElement('canvas')
      srcCanvas.width = Math.max(1, img.width)
      srcCanvas.height = Math.max(1, img.height)
      const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
      if (!srcCtx) return
      srcCtx.clearRect(0, 0, srcCanvas.width, srcCanvas.height)
      srcCtx.drawImage(img, 0, 0)
      const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height).data

      let minX = srcCanvas.width - 1
      let minY = srcCanvas.height - 1
      let maxX = 0
      let maxY = 0
      let hasVisiblePixels = false
      for (let y = 0; y < srcCanvas.height; y += 1) {
        for (let x = 0; x < srcCanvas.width; x += 1) {
          const a = srcData[(y * srcCanvas.width + x) * 4 + 3]
          if (a > alphaThreshold) {
            hasVisiblePixels = true
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      const srcX = hasVisiblePixels ? minX : 0
      const srcY = hasVisiblePixels ? minY : 0
      const srcW = hasVisiblePixels ? Math.max(1, maxX - minX + 1) : img.width
      const srcH = hasVisiblePixels ? Math.max(1, maxY - minY + 1) : img.height

      const baseTurns = orientation === 'column' ? 1 : 0
      const userTurns =
        rotationMode === '90 clockwise' ? 1 : rotationMode === '90 counterclockwise' ? -1 : 0
      const quarterTurns = normalizeQuarterTurns(baseTurns + userTurns)
      const isSwapped = quarterTurns % 2 === 1

      if (quarterTurns !== 0) {
        const fitW = isSwapped ? srcH : srcW
        const fitH = isSwapped ? srcW : srcH
        const scale = Math.min(width / fitW, height / fitH)
        const drawW = Math.max(1, Math.floor(fitW * scale))
        const drawH = Math.max(1, Math.floor(fitH * scale))
        const offsetX = Math.floor((width - drawW) / 2)
        const offsetY = Math.floor((height - drawH) / 2)
        ctx.save()
        ctx.translate(offsetX + drawW / 2, offsetY + drawH / 2)
        ctx.rotate((Math.PI / 2) * quarterTurns)
        const destW = isSwapped ? drawH : drawW
        const destH = isSwapped ? drawW : drawH
        ctx.drawImage(
          img,
          srcX,
          srcY,
          srcW,
          srcH,
          -destW / 2,
          -destH / 2,
          destW,
          destH,
        )
        ctx.restore()
      } else {
        // Draw uploaded shape with "contain" behavior.
        const scale = Math.min(width / srcW, height / srcH)
        const drawW = Math.max(1, Math.floor(srcW * scale))
        const drawH = Math.max(1, Math.floor(srcH * scale))
        const offsetX = Math.floor((width - drawW) / 2)
        const offsetY = Math.floor((height - drawH) / 2)
        ctx.drawImage(img, srcX, srcY, srcW, srcH, offsetX, offsetY, drawW, drawH)
      }

      const image = ctx.getImageData(0, 0, width, height)
      const data = image.data
      const len = width * height
      const edge = new Uint8Array(len)
      const outside = new Uint8Array(len)
      const queue = new Int32Array(len)
      let qHead = 0
      let qTail = 0

      for (let i = 0; i < len; i += 1) {
        edge[i] = data[i * 4 + 3] > alphaThreshold ? 1 : 0
      }

      const enqueueOutside = (x: number, y: number) => {
        const idx = y * width + x
        if (edge[idx] === 1 || outside[idx] === 1) return
        outside[idx] = 1
        queue[qTail] = idx
        qTail += 1
      }

      for (let x = 0; x < width; x += 1) {
        enqueueOutside(x, 0)
        enqueueOutside(x, height - 1)
      }
      for (let y = 1; y < height - 1; y += 1) {
        enqueueOutside(0, y)
        enqueueOutside(width - 1, y)
      }

      while (qHead < qTail) {
        const idx = queue[qHead]
        qHead += 1
        const x = idx % width
        const y = (idx - x) / width
        if (x > 0) enqueueOutside(x - 1, y)
        if (x < width - 1) enqueueOutside(x + 1, y)
        if (y > 0) enqueueOutside(x, y - 1)
        if (y < height - 1) enqueueOutside(x, y + 1)
      }

      const [outlineR, outlineG, outlineB, outlineA] = cssColorToRgba(outlineColor)
      const [fillR, fillG, fillB, fillA] = cssColorToRgba(fillColor)

      // Align fill range to true interior bounds (Y for row mode, X for column mode).
      let minInteriorY = height - 1
      let maxInteriorY = 0
      let minInteriorX = width - 1
      let maxInteriorX = 0
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = y * width + x
          const isInterior = edge[idx] === 0 && outside[idx] === 0
          if (isInterior) {
            if (y < minInteriorY) minInteriorY = y
            if (y > maxInteriorY) maxInteriorY = y
            if (x < minInteriorX) minInteriorX = x
            if (x > maxInteriorX) maxInteriorX = x
          }
        }
      }
      const interiorSpan = Math.max(1, maxInteriorY - minInteriorY)
      const fillStartY = Math.round(maxInteriorY - (value / 100) * interiorSpan)
      const interiorSpanX = Math.max(1, maxInteriorX - minInteriorX)
      const fillEndX = Math.round(minInteriorX + (value / 100) * interiorSpanX)

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = y * width + x
          const pixel = idx * 4
          if (edge[idx] === 1) {
            data[pixel] = outlineR
            data[pixel + 1] = outlineG
            data[pixel + 2] = outlineB
            data[pixel + 3] = outlineA
            continue
          }
          const isInterior = edge[idx] === 0 && outside[idx] === 0
          const isFilled =
            orientation === 'column' ? isInterior && x <= fillEndX : isInterior && y >= fillStartY
          if (isFilled) {
            data[pixel] = fillR
            data[pixel + 1] = fillG
            data[pixel + 2] = fillB
            data[pixel + 3] = fillA
          } else {
            data[pixel] = 0
            data[pixel + 1] = 0
            data[pixel + 2] = 0
            data[pixel + 3] = 0
          }
        }
      }

      ctx.putImageData(image, 0, 0)
    }
    img.src = shapeSrc
  }, [fillColor, orientation, outlineColor, rotationMode, shapeSrc, value])

  return (
    <canvas
      ref={canvasRef}
      className={`shape-canvas ${orientation === 'column' ? 'horizontal' : 'vertical'}`}
      width={orientation === 'column' ? 270 : 180}
      height={orientation === 'column' ? 180 : 270}
    />
  )
}

function App() {
  useEditorPanelConfig([
    { name: 'data source', type: 'element' },
    { name: 'label column', type: 'column', source: 'data source', allowMultiple: false },
    { name: 'value column', type: 'column', source: 'data source', allowMultiple: false },
    { name: 'background color', type: 'color' },
    { name: 'shape color', type: 'color' },
    { name: 'fill color', type: 'color' },
    { name: 'label color', type: 'color' },
    { name: 'shape URL', type: 'text', placeholder: 'https://example.com/shape.png' },
    { name: 'shape image base64', type: 'text', multiline: true },
    { name: 'show upload controls', type: 'toggle', defaultValue: true },
    { name: 'icon scale (%)', type: 'text', defaultValue: '100', placeholder: '50-200' },
    {
      name: 'image rotation',
      type: 'dropdown',
      values: ['default', '90 clockwise', '90 counterclockwise'],
      defaultValue: 'default',
    },
    { name: 'interaction output label', type: 'text', defaultValue: 'Selected Dimension' },
    { name: 'target control variable', type: 'variable', allowedTypes: ['text', 'text-list'] },
    { name: 'show dimension label', type: 'toggle', defaultValue: true },
    { name: 'show metric label', type: 'toggle', defaultValue: true },
    {
      name: 'metric display',
      type: 'dropdown',
      values: ['percent', 'raw', 'both'],
      defaultValue: 'percent',
    },
    {
      name: 'mark order',
      type: 'dropdown',
      values: ['source order', 'label asc', 'label desc', 'value asc', 'value desc'],
      defaultValue: 'source order',
    },
    {
      name: 'layout',
      type: 'radio',
      values: ['row', 'column'],
      defaultValue: 'row',
      singleLine: true,
    },
    { name: 'mark gap (px)', type: 'text', defaultValue: '8', placeholder: '0-40' },
    { name: 'shape selected', type: 'interaction' },
    { name: 'shape click trigger', type: 'action-trigger' },
  ])

  const plugin = usePlugin()
  const pluginStyle = usePluginStyle()
  const rawConfig = useConfig()
  const config = useMemo(() => rawConfig ?? {}, [rawConfig])
  const sourceId = readConfigId(config['data source'])
  const elementDataByConfigRaw = useElementData('data source')
  const elementDataBySourceRaw = useElementData(sourceId || 'data source')
  const elementDataRaw =
    elementDataBySourceRaw && Object.keys(elementDataBySourceRaw).length > 0
      ? elementDataBySourceRaw
      : elementDataByConfigRaw
  const elementData = useMemo(
    () => ((elementDataRaw ?? {}) as Record<string, unknown[]>),
    [elementDataRaw],
  )
  useElementColumns(sourceId)

  const labelKey = readConfigId(config['label column'])
  const valueKey = readConfigId(config['value column'])

  const labels = useMemo<unknown[]>(
    () => elementData[labelKey] ?? [],
    [elementData, labelKey],
  )
  const values = useMemo<unknown[]>(
    () => elementData[valueKey] ?? [],
    [elementData, valueKey],
  )
  const rowCount = Math.max(labels.length, values.length)

  const rows = useMemo<ChartRow[]>(() => {
    const numericValues = values
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0)
    const hasAbsoluteValues = numericValues.some((v) => v > 1)
    const maxAbsolute = hasAbsoluteValues ? Math.max(...numericValues, 1) : 1

    const nextRows: ChartRow[] = []
    for (let index = 0; index < rowCount; index += 1) {
      const label = labels[index] == null ? `Item ${index + 1}` : String(labels[index])
      const rawValue = values[index]
      const numeric = Number(rawValue)
      const scaled =
        Number.isFinite(numeric) && numeric >= 0
          ? hasAbsoluteValues
            ? (numeric / maxAbsolute) * 100
            : coercePercent(numeric)
          : 0
      nextRows.push({
        label,
        value: Math.max(0, Math.min(100, scaled)),
        rawValue,
        rawDisplay: formatRawValue(rawValue),
      })
    }
    return nextRows
  }, [labels, rowCount, values])

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const interactionConfigId = readConfigId(config['shape selected'])
  const actionTriggerConfigId = readConfigId(config['shape click trigger'])
  const targetControlVariableId = readConfigId(config['target control variable'])
  const [interactionValue, setInteractionValue] = useInteraction(
    interactionConfigId || 'shape selected',
    sourceId || 'data source',
  ) as [unknown[] | undefined, (value: unknown[]) => void]
  const triggerAction = useActionTrigger(actionTriggerConfigId || 'shape click trigger')
  const [, setTargetControlValue] = useVariable(targetControlVariableId || 'target control variable')

  const configuredBackground = readColorConfig(config['background color'], '#F3F3F3')
  const configuredShape = readColorConfig(config['shape color'], '#545454')
  const configuredFill = readColorConfig(config['fill color'], '#A0CBE8')
  const configuredLabelColor = readColorConfig(config['label color'], '#545454')

  useEffect(() => {
    const missingDefaults: Record<string, string> = {}
    if (config['background color'] == null) missingDefaults['background color'] = '#F3F3F3'
    if (config['shape color'] == null) missingDefaults['shape color'] = '#545454'
    if (config['fill color'] == null) missingDefaults['fill color'] = '#A0CBE8'
    if (config['label color'] == null) missingDefaults['label color'] = '#545454'
    if (Object.keys(missingDefaults).length > 0) {
      plugin.config.set(missingDefaults as never)
    }
  }, [config, plugin])

  const backgroundColor = configuredBackground || pluginStyle?.backgroundColor || '#F3F3F3'
  const shapeColor = configuredShape
  const fillColor = configuredFill
  const labelColor = configuredLabelColor
  const showDimensionLabel = Boolean(config['show dimension label'] ?? true)
  const showMetricLabel = Boolean(config['show metric label'] ?? true)
  const metricDisplay = String(config['metric display'] || 'percent')
  const showUploadControls = Boolean(config['show upload controls'] ?? true)
  const rotationMode = String(config['image rotation'] || 'default')
  const iconScaleRaw = Number(config['icon scale (%)'] ?? 100)
  const iconScalePct = Number.isFinite(iconScaleRaw) ? Math.max(50, Math.min(200, iconScaleRaw)) : 100
  const iconScale = iconScalePct / 100
  const markOrder = String(config['mark order'] || 'source order')
  const layout = (String(config.layout || 'row') === 'column' ? 'column' : 'row') as 'row' | 'column'
  const gapRaw = Number(config['mark gap (px)'] ?? 8)
  const markGapPx = Number.isFinite(gapRaw) ? Math.max(0, Math.min(40, gapRaw)) : 8
  const uploadedBase64 = String(config['shape image base64'] || '')
  const urlShape = String(config['shape URL'] || '')
  const shapeSrc = uploadedBase64 || urlShape
  const interactionOutputLabel = String(config['interaction output label'] || 'Selected Dimension')

  const hasConfiguredColumns = Boolean(labelKey && valueKey)
  const sortedRows = useMemo(() => {
    const copy = [...rows]
    switch (markOrder) {
      case 'label asc':
        return copy.sort((a, b) => a.label.localeCompare(b.label))
      case 'label desc':
        return copy.sort((a, b) => b.label.localeCompare(a.label))
      case 'value asc':
        return copy.sort((a, b) => a.value - b.value)
      case 'value desc':
        return copy.sort((a, b) => b.value - a.value)
      default:
        return copy
    }
  }, [markOrder, rows])
  const hasData = sortedRows.length > 0 && hasConfiguredColumns

  const onShapeClick = (index: number, row: ChartRow) => {
    setSelectedIdx(index)
    if (interactionConfigId && sourceId && labelKey) {
      const selectionRecord: Record<string, { type: string; val?: unknown }> = {
        [interactionOutputLabel]: {
          type: selectionTypeFor(row.label),
          val: row.label,
        },
      }
      setInteractionValue([selectionRecord as never])
    }
    if (targetControlVariableId) {
      setTargetControlValue(row.label)
    }
    if (actionTriggerConfigId) {
      triggerAction()
    }
  }

  const onUploadShape = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.type !== 'image/png') return
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      plugin.config.setKey('shape image base64', value as never)
    }
    reader.readAsDataURL(file)
  }

  return (
    <main className="plugin-root" style={{ backgroundColor }}>
      {showUploadControls && (
        <header className="toolbar">
          <div className="toolbar-group">
            <label htmlFor="shapeUpload">Upload PNG Shape</label>
            <input id="shapeUpload" type="file" accept="image/png" onChange={onUploadShape} />
          </div>
          <div className="toolbar-group slider-group">
            <label htmlFor="iconScaleSlider">Icon Scale ({iconScalePct.toFixed(0)}%)</label>
            <input
              id="iconScaleSlider"
              type="range"
              min={50}
              max={200}
              step={5}
              value={iconScalePct}
              onChange={(event) => plugin.config.setKey('icon scale (%)', event.target.value as never)}
            />
          </div>
          <button
            type="button"
            onClick={() => plugin.config.setKey('shape image base64', '' as never)}
            className="secondary-button"
          >
            Clear uploaded shape
          </button>
        </header>
      )}
      <section className="chart-shell">
        <div className="chart-area">
          {selectedIdx === null && (
            <p className="intro-text">
              Upload or set a PNG shape, map `label column` and `value column`, then click a shape to
              select it and trigger configured actions.
            </p>
          )}
          {!shapeSrc && (
            <p className="empty-state">
              Add a PNG in “shape URL” or upload one using the file picker.
            </p>
          )}
          {!hasConfiguredColumns && (
            <p className="empty-state">
              Configure `label column` and `value column` in the editor panel.
            </p>
          )}
          {hasConfiguredColumns && rows.length === 0 && (
            <p className="empty-state">
              Columns are configured but no rows were returned from the selected source.
            </p>
          )}

          {shapeSrc && hasData && (
            <div
              className={`shape-grid ${layout === 'column' ? 'column-layout' : 'row-layout'} ${
                !showDimensionLabel && !showMetricLabel ? 'labels-hidden' : ''
              }`}
              style={
                {
                  gap: `${markGapPx}px`,
                  '--icon-scale': String(iconScale),
                } as CSSProperties
              }
            >
              {sortedRows.map((row, idx) => {
                const selected = selectedIdx === idx
                return (
                  <button
                    key={`${row.label}-${idx}`}
                    type="button"
                    className={`shape-card ${selected ? 'selected' : ''}`}
                    onClick={() => onShapeClick(idx, row)}
                  >
                    <ShapeGlyph
                      shapeSrc={shapeSrc}
                      value={row.value}
                      outlineColor={shapeColor}
                      fillColor={fillColor}
                      orientation={layout}
                      rotationMode={rotationMode}
                    />
                    <div className="shape-label-block" style={{ color: labelColor }}>
                      {showDimensionLabel && <div className="shape-label">{row.label}</div>}
                      {showMetricLabel && (
                        <div className="shape-value">
                          {metricDisplay === 'raw' && row.rawDisplay}
                          {metricDisplay === 'both' &&
                            `${row.rawDisplay}${row.rawDisplay ? ' ' : ''}(${row.value.toFixed(1)}%)`}
                          {metricDisplay === 'percent' && `${row.value.toFixed(1)}%`}
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </section>
      {Array.isArray(interactionValue) && interactionValue.length > 0 && (
        <footer className="selection-footer">Selection active: {interactionValue.length} item(s)</footer>
      )}
    </main>
  )
}

export default App
