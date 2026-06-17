import { type CSSProperties, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { parseExecuteProgress, tokenizeExecute } from './parser/executeParser'
import { evaluateExecute } from './simulator/executeSimulator'
import type { CommandSourceState, ParseError, Vec3 } from './types/execute'
import { parseMacroArgumentsInput, resolveCommandMacro } from './macros/commandMacro'
import { ThreeViewer } from './viewer/ThreeViewer'
import { getCommandCompletionContext, type CommandCompletion } from './completions/executeCompletions'
import {
  VIEW_TARGET_ENTITY_PREFIX,
  createDefaultEntityName,
  createPanel,
  createPanelId,
  findViewTargetPanel,
  normalizeEntityDimensionFields,
  normalizeNumericString,
  normalizePanelFieldString,
  parseNumberOrZero,
  toEntityState,
  type EntityPanel,
  type NumericField,
  type PositionField,
} from './entities/entityPanelState'
import { createSerializedAppState, parseSerializedAppState } from './state/serializedAppState'
import { getSelectorVisualization } from './selectors/selectorVisualization'
import {
  ROOT_COMMAND_SOURCE_STATE,
  buildBranchLastStateMap,
  buildBranchRows,
  buildRunMarkerStates,
  collectHeaderHighlightedStepIds,
  filterVisibleIds,
  resolveHoveredState,
  type BranchRow,
  type RunMarkerState,
} from './branching/executeBranchState'
import { EntityPanelCard } from './components/EntityPanelCard'
import { CommandBranchTree } from './components/CommandBranchTree'
import { ViewOptionsPanel } from './components/ViewOptionsPanel'
import { MacroArgsPanel } from './components/MacroArgsPanel'
import { PanelCollapseButton } from './components/PanelCollapseButton'

const INCOMPLETE_PARSE_MESSAGES = new Set([
  'Expected an entity selector.',
  'Expected 3 coordinates.',
  'align requires one or more axes.',
  'rotated requires yaw and pitch.',
  'Expected an if condition.',
  'Expected an unless condition.',
  "Expected 'eyes' or 'feet' after 'anchored'.",
  "Expected 'feet' or 'eyes' after 'facing entity <selector>'.",
  'Incomplete entity selector.',
  'Incomplete macro placeholder.',
  'Incomplete macro command.',
])

const shouldSuppressParseError = (message: string, tokenIndex: number, tokenCount: number): boolean =>
  (INCOMPLETE_PARSE_MESSAGES.has(message) || message.startsWith('Incomplete if ') || message.startsWith('Incomplete unless ')) &&
  tokenIndex >= Math.max(0, tokenCount - 1)

const SPIN_STEP_BY_FIELD: Record<NumericField, number> = {
  x: 0.1,
  y: 0.1,
  z: 0.1,
  yaw: 1,
  pitch: 1,
  height: 0.1,
  width: 0.1,
  eyeHeight: 0.1,
}

const MAX_MARKER_SIZE = 6
const DEFAULT_MARKER_SIZE = 3
const DEFAULT_MARKER_OPACITY = 75
const MIN_VIEW_OPTIONS_WIDTH = 260
const DEFAULT_VIEW_OPTIONS_WIDTH = 320
const MIN_VIEWER_WIDTH = 320
const COLLAPSED_SIDE_PANEL_WIDTH = 52
const COLLAPSED_VIEW_OPTIONS_WIDTH = 52
const MIN_ENTITIES_PANEL_WIDTH = 400
const reorderPanels = (panels: EntityPanel[], fromId: string, toId: string): EntityPanel[] => {
  const fromIndex = panels.findIndex((panel) => panel.id === fromId)
  const toIndex = panels.findIndex((panel) => panel.id === toId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return panels
  }

  const next = [...panels]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function App() {
  const [command, setCommand] = useState('')
  const [hoveredStepId, setHoveredStepId] = useState<string | null>(null)
  const [hoveredSelectorPreview, setHoveredSelectorPreview] = useState<{ branchId: string; subcommandIndex: number } | null>(null)
  const [hoveredEntityPanelId, setHoveredEntityPanelId] = useState<string | null>(null)
  const [hoveredRunBranchId, setHoveredRunBranchId] = useState<string | null>(null)
  const [hoveredRowBranchId, setHoveredRowBranchId] = useState<string | null>(null)
  const [hoveredColumnIndex, setHoveredColumnIndex] = useState<number | null>(null)
  const [hoveringRunColumn, setHoveringRunColumn] = useState(false)
  const [hoveringRoot, setHoveringRoot] = useState(false)
  const [hoverTooltip, setHoverTooltip] = useState<{ x: number; y: number } | null>(null)
  const [hiddenStepIdsState, setHiddenStepIdsState] = useState<string[]>([])
  const [hiddenRunBranchIdsState, setHiddenRunBranchIdsState] = useState<string[]>([])
  const [draggedPanelId, setDraggedPanelId] = useState<string | null>(null)

  const [entityPanels, setEntityPanels] = useState<EntityPanel[]>([createPanel('e-1', 'entity1')])
  const [sidePanelWidth, setSidePanelWidth] = useState(560)
  const [isResizingSidePanel, setIsResizingSidePanel] = useState(false)
  const contentLayoutRef = useRef<HTMLElement | null>(null)
  const [viewOptionsWidth, setViewOptionsWidth] = useState(DEFAULT_VIEW_OPTIONS_WIDTH)
  const [isResizingViewOptions, setIsResizingViewOptions] = useState(false)
  const viewerPanelRef = useRef<HTMLElement | null>(null)
  const [commandPanelHeight, setCommandPanelHeight] = useState(260)
  const [isResizingCommandPanel, setIsResizingCommandPanel] = useState(false)
  const appRootRef = useRef<HTMLDivElement | null>(null)
  const [viewMarkerSize, setViewMarkerSize] = useState(DEFAULT_MARKER_SIZE)
  const [viewMarkerOpacity, setViewMarkerOpacity] = useState(DEFAULT_MARKER_OPACITY)
  const [viewTargetSelection, setViewTargetSelection] = useState('coords')
  const [commandCursor, setCommandCursor] = useState(0)
  const [isCommandFocused, setIsCommandFocused] = useState(false)
  const [activeCompletionIndex, setActiveCompletionIndex] = useState(0)
  const commandInputRef = useRef<HTMLInputElement | null>(null)
  const pendingCommandCursorRef = useRef<number | null>(null)
  const [viewTargetX, setViewTargetX] = useState('0')
  const [viewTargetY, setViewTargetY] = useState('0')
  const [viewTargetZ, setViewTargetZ] = useState('0')
  const [macroArgsInput, setMacroArgsInput] = useState('')
  const [saveLoadStatus, setSaveLoadStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [isViewerSideCollapsed, setIsViewerSideCollapsed] = useState(false)
  const [isEntitiesCollapsed, setIsEntitiesCollapsed] = useState(false)
  const [isCommandTreeCollapsed, setIsCommandTreeCollapsed] = useState(false)

  const effectiveSidePanelWidth = isEntitiesCollapsed ? COLLAPSED_SIDE_PANEL_WIDTH : sidePanelWidth
  const effectiveViewOptionsWidth = isViewerSideCollapsed ? COLLAPSED_VIEW_OPTIONS_WIDTH : viewOptionsWidth

  const allEntities = useMemo(() => entityPanels.map((panel) => toEntityState(panel)), [entityPanels])
  const visibleEntities = useMemo(
    () => entityPanels.filter((panel) => panel.markerVisible).map((panel) => toEntityState(panel)),
    [entityPanels],
  )
  const activeEntity = useMemo(() => allEntities[0] ?? null, [allEntities])
  const executeContext = useMemo(
    () => ({
      entity: activeEntity ?? undefined,
      entities: allEntities,
    }),
    [activeEntity, allEntities],
  )

  const markerSizeMultiplier = useMemo(() => Math.min(Math.max(viewMarkerSize, 0), MAX_MARKER_SIZE), [viewMarkerSize])
  const markerOpacity = useMemo(() => Math.min(Math.max(viewMarkerOpacity / 100, 0), 1), [viewMarkerOpacity])

  const cameraTarget = useMemo<Vec3>(() => {
    if (viewTargetSelection === 'coords') {
      return {
        x: parseNumberOrZero(viewTargetX),
        y: parseNumberOrZero(viewTargetY),
        z: parseNumberOrZero(viewTargetZ),
      }
    }

    const panel = findViewTargetPanel(viewTargetSelection, entityPanels)

    if (panel) {
      return toEntityState(panel).position
    }

    return activeEntity?.position ?? { x: 0, y: 0, z: 0 }
  }, [viewTargetSelection, entityPanels, activeEntity, viewTargetX, viewTargetY, viewTargetZ])


  const macroArgumentsResult = useMemo(() => parseMacroArgumentsInput(macroArgsInput), [macroArgsInput])
  const macroCommandResult = useMemo(() => {
    if (!command.startsWith('$')) {
      return { ok: true as const, command }
    }
    if (!macroArgumentsResult.ok) {
      return { ok: false as const, error: macroArgumentsResult.error, tokenIndex: 0, token: 'macro args' }
    }
    return resolveCommandMacro(command, macroArgumentsResult.value)
  }, [command, macroArgumentsResult])
  const effectiveCommand = macroCommandResult.ok ? macroCommandResult.command : ''

  const parseProgress = useMemo(() => parseExecuteProgress(effectiveCommand, executeContext), [effectiveCommand, executeContext])
  const rawCommandTokens = useMemo(() => tokenizeExecute(command), [command])
  const commandTokens = useMemo(() => tokenizeExecute(effectiveCommand), [effectiveCommand])

  const partialEvaluatedCommand = useMemo(() => {
    const subcommands = parseProgress.ast.subcommands
    if (subcommands.length === 0) {
      return ''
    }

    const prefix = commandTokens[0] === 'execute' ? ['execute'] : []
    const body = subcommands.map((subcommand) =>
      commandTokens.slice(subcommand.tokenRange.start, subcommand.tokenRange.end + 1).join(' '),
    )

    return [...prefix, ...body].join(' ')
  }, [commandTokens, parseProgress.ast.subcommands])

  const partialResult = useMemo(() => {
    if (partialEvaluatedCommand.length === 0) {
      return { ok: true as const, steps: [] }
    }
    return evaluateExecute(partialEvaluatedCommand, executeContext)
  }, [partialEvaluatedCommand, executeContext])

  const displayedSteps = useMemo(
    () => (partialResult.ok ? partialResult.steps : []),
    [partialResult],
  )
  const visibleStepIdSet = useMemo(() => new Set(displayedSteps.map((step) => step.id)), [displayedSteps])
  const hiddenStepIds = useMemo(() => filterVisibleIds(hiddenStepIdsState, visibleStepIdSet), [hiddenStepIdsState, visibleStepIdSet])

  const visibleParseError = useMemo<ParseError | null>(() => {
    if (!macroCommandResult.ok) {
      return shouldSuppressParseError(macroCommandResult.error, macroCommandResult.tokenIndex, rawCommandTokens.length)
        ? null
        : { message: macroCommandResult.error, tokenIndex: macroCommandResult.tokenIndex, token: macroCommandResult.token }
    }
    if (!parseProgress.error) {
      return null
    }
    return shouldSuppressParseError(parseProgress.error.message, parseProgress.error.tokenIndex, commandTokens.length)
      ? null
      : parseProgress.error
  }, [macroCommandResult, parseProgress.error, rawCommandTokens.length, commandTokens.length])

  const subcommandTexts = useMemo(
    () =>
      parseProgress.ast.subcommands.map((subcommand) =>
        commandTokens.slice(subcommand.tokenRange.start, subcommand.tokenRange.end + 1).join(' '),
      ),
    [commandTokens, parseProgress.ast.subcommands],
  )

  const commandCompletionContext = useMemo(() => {
    if (!command.startsWith('$')) {
      return getCommandCompletionContext(command, commandCursor, entityPanels)
    }
    if (commandCursor <= 0) {
      return { items: [], rangeStart: 0, rangeEnd: 0 }
    }

    const innerContext = getCommandCompletionContext(command.slice(1), Math.max(commandCursor - 1, 0), entityPanels)
    return {
      items: innerContext.items,
      rangeStart: innerContext.rangeStart + 1,
      rangeEnd: innerContext.rangeEnd + 1,
    }
  }, [command, commandCursor, entityPanels])
  const commandCompletions = commandCompletionContext.items
  const showCommandCompletions = isCommandFocused && commandCompletions.length > 0
  const boundedActiveCompletionIndex = showCommandCompletions
    ? Math.min(activeCompletionIndex, commandCompletions.length - 1)
    : 0

  const applyCommandCompletion = (completion: CommandCompletion) => {
    const nextCommand =
      command.slice(0, commandCompletionContext.rangeStart) +
      completion.insertText +
      command.slice(commandCompletionContext.rangeEnd)
    const nextCursor = commandCompletionContext.rangeStart + completion.insertText.length

    setCommand(nextCommand)
    setCommandCursor(nextCursor)
    setActiveCompletionIndex(0)
    pendingCommandCursorRef.current = nextCursor

    window.requestAnimationFrame(() => {
      const input = commandInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const updateCommandCursor = (value: number | null | undefined) => {
    setCommandCursor(typeof value === 'number' ? value : command.length)
  }

  
  const runTokenIndex = useMemo(() => commandTokens.indexOf('run'), [commandTokens])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const input = commandInputRef.current
      if (!input) {
        return
      }

      const target = event.target as Node
      if (input === target || input.parentElement?.contains(target)) {
        return
      }

      setIsCommandFocused(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  useEffect(() => {
    if (!isCommandFocused) {
      return
    }

    const nextCursor = pendingCommandCursorRef.current
    if (nextCursor === null) {
      return
    }

    const input = commandInputRef.current
    if (!input) {
      return
    }

    pendingCommandCursorRef.current = null
    const boundedCursor = Math.min(nextCursor, command.length)
    window.requestAnimationFrame(() => {
      input.setSelectionRange(boundedCursor, boundedCursor)
    })
  }, [command, isCommandFocused])

  useEffect(() => {
    if (saveLoadStatus === null) {
      return
    }

    const timer = window.setTimeout(() => setSaveLoadStatus(null), 2400)
    return () => window.clearTimeout(timer)
  }, [saveLoadStatus])

  useEffect(() => {
    if (!isResizingSidePanel) {
      return
    }

    const handleMouseMove = (event: MouseEvent) => {
      const layout = contentLayoutRef.current
      if (!layout) {
        return
      }

      const rect = layout.getBoundingClientRect()
      const minPanelWidth = MIN_ENTITIES_PANEL_WIDTH
      const splitterWidth = 8
      const layoutColumnGap = Number.parseFloat(window.getComputedStyle(layout).columnGap) || 0
      const viewerInternalGap = 8
      const minViewerPanelWidth =
        MIN_VIEWER_WIDTH +
        splitterWidth +
        MIN_VIEW_OPTIONS_WIDTH +
        viewerInternalGap * 2
      const maxPanelWidth = Math.max(
        minPanelWidth,
        rect.width - minViewerPanelWidth - splitterWidth - layoutColumnGap * 2,
      )
      const nextPanelWidth = rect.right - event.clientX - splitterWidth / 2
      const clamped = Math.min(maxPanelWidth, Math.max(minPanelWidth, nextPanelWidth))
      setSidePanelWidth(Math.round(clamped))
    }

    const stopResize = () => setIsResizingSidePanel(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [isResizingSidePanel])

  useEffect(() => {
    if (!isResizingViewOptions) {
      return
    }

    const handleMouseMove = (event: MouseEvent) => {
      const layout = viewerPanelRef.current
      if (!layout) {
        return
      }

      const rect = layout.getBoundingClientRect()
      const splitterWidth = 8
      const minViewerWidth = MIN_VIEWER_WIDTH
      const maxPanelWidth = Math.max(MIN_VIEW_OPTIONS_WIDTH, rect.width - minViewerWidth - splitterWidth)
      const nextPanelWidth = rect.right - event.clientX - splitterWidth / 2
      const clamped = Math.min(maxPanelWidth, Math.max(MIN_VIEW_OPTIONS_WIDTH, nextPanelWidth))
      setViewOptionsWidth(Math.round(clamped))
    }

    const stopResize = () => setIsResizingViewOptions(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [isResizingViewOptions])

  useEffect(() => {
    if (!isResizingCommandPanel) {
      return
    }

    const handleMouseMove = (event: MouseEvent) => {
      const root = appRootRef.current
      if (!root) {
        return
      }

      const rect = root.getBoundingClientRect()
      const minPanelHeight = 120
      const minMainHeight = 120
      const splitterHeight = 8
      const maxPanelHeight = Math.max(minPanelHeight, rect.height - minMainHeight - splitterHeight)
      const nextPanelHeight = rect.bottom - event.clientY - splitterHeight / 2
      const clamped = Math.min(maxPanelHeight, Math.max(minPanelHeight, nextPanelHeight))
      setCommandPanelHeight(Math.round(clamped))
    }

    const stopResize = () => setIsResizingCommandPanel(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [isResizingCommandPanel])

  const branchRows = useMemo<BranchRow[]>(() => buildBranchRows(displayedSteps), [displayedSteps])
  const branchRowById = useMemo(() => new Map(branchRows.map((row) => [row.branchId, row])), [branchRows])
  const branchLastStateMap = useMemo(() => buildBranchLastStateMap(branchRows), [branchRows])
  const runMarkerStates = useMemo<RunMarkerState[]>(
    () => buildRunMarkerStates(runTokenIndex, displayedSteps.length, branchRows, ROOT_COMMAND_SOURCE_STATE),
    [runTokenIndex, displayedSteps.length, branchRows],
  )
  const visibleRunBranchIdSet = useMemo(() => new Set(runMarkerStates.map((entry) => entry.branchId)), [runMarkerStates])
  const hiddenRunBranchIds = useMemo(
    () => filterVisibleIds(hiddenRunBranchIdsState, visibleRunBranchIdSet),
    [hiddenRunBranchIdsState, visibleRunBranchIdSet],
  )

  const headerHighlightedStepIds = useMemo<string[]>(
    () => collectHeaderHighlightedStepIds(displayedSteps, hoveringRoot, hoveredRowBranchId, hoveredColumnIndex),
    [displayedSteps, hoveringRoot, hoveredRowBranchId, hoveredColumnIndex],
  )
  const hoveredState = useMemo<CommandSourceState | null>(
    () =>
      resolveHoveredState(
        hoveringRoot,
        hoveredRunBranchId,
        hoveredStepId,
        displayedSteps,
        branchLastStateMap,
        ROOT_COMMAND_SOURCE_STATE,
      ),
    [hoveringRoot, hoveredRunBranchId, hoveredStepId, displayedSteps, branchLastStateMap],
  )
  const hoveredStep = useMemo(
    () => (hoveredStepId ? displayedSteps.find((candidate) => candidate.id === hoveredStepId) ?? null : null),
    [hoveredStepId, displayedSteps],
  )
  const hoveredSelectorPreviewVisualization = useMemo(() => {
    if (hoveredSelectorPreview === null) {
      return null
    }

    const subcommand = parseProgress.ast.subcommands[hoveredSelectorPreview.subcommandIndex]
    const row = branchRowById.get(hoveredSelectorPreview.branchId)
    if (!subcommand || !row) {
      return null
    }

    const exactStep = row.steps.find((step) => step.index === hoveredSelectorPreview.subcommandIndex)
    const previousStep = [...row.steps]
      .reverse()
      .find((step) => step.index < hoveredSelectorPreview.subcommandIndex)
    const previewState = exactStep?.before ?? previousStep?.after ?? ROOT_COMMAND_SOURCE_STATE

    return getSelectorVisualization(subcommand, previewState)
  }, [hoveredSelectorPreview, parseProgress.ast.subcommands, branchRowById])
  const selectorVisualization = useMemo(
    () => (hoveredStep ? getSelectorVisualization(hoveredStep.subcommand, hoveredStep.before) : hoveredSelectorPreviewVisualization),
    [hoveredStep, hoveredSelectorPreviewVisualization],
  )
  const handleToggleAll = () => {
    const stepIds = displayedSteps.map((step) => step.id)
    const runBranchIds = runTokenIndex >= 0 ? runMarkerStates.map((entry) => entry.branchId) : []
    const hasSteps = stepIds.length > 0
    const hasRuns = runBranchIds.length > 0

    if (!hasSteps && !hasRuns) {
      return
    }

    const allStepsHidden = hasSteps && stepIds.every((id) => hiddenStepIds.includes(id))
    const allRunsHidden = hasRuns && runBranchIds.every((id) => hiddenRunBranchIds.includes(id))
    const shouldShowAll = (hasSteps ? allStepsHidden : true) && (hasRuns ? allRunsHidden : true)

    if (hasSteps) {
      setHiddenStepIdsState((prev) => {
        const hiddenSet = new Set(prev)
        if (shouldShowAll) {
          stepIds.forEach((id) => hiddenSet.delete(id))
        } else {
          stepIds.forEach((id) => hiddenSet.add(id))
        }
        return Array.from(hiddenSet)
      })
    }

    if (hasRuns) {
      setHiddenRunBranchIdsState((prev) => {
        const hiddenSet = new Set(prev)
        if (shouldShowAll) {
          runBranchIds.forEach((id) => hiddenSet.delete(id))
        } else {
          runBranchIds.forEach((id) => hiddenSet.add(id))
        }
        return Array.from(hiddenSet)
      })
    }
  }

  const toggleStepVisibility = (stepId: string) => {
    setHiddenStepIdsState((prev) =>
      prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId],
    )
  }

  const toggleRunVisibility = (branchId: string) => {
    setHiddenRunBranchIdsState((prev) =>
      prev.includes(branchId) ? prev.filter((id) => id !== branchId) : [...prev, branchId],
    )
  }

  const toggleAllRunVisibility = () => {
    toggleRunBranchesVisibility(runMarkerStates.map((entry) => entry.branchId))
  }


  const toggleStepsVisibility = (stepIds: string[]) => {
    if (stepIds.length === 0) {
      return
    }

    setHiddenStepIdsState((prev) => {
      const hiddenSet = new Set(prev)
      const allHidden = stepIds.every((id) => hiddenSet.has(id))

      if (allHidden) {
        stepIds.forEach((id) => hiddenSet.delete(id))
      } else {
        stepIds.forEach((id) => hiddenSet.add(id))
      }

      return Array.from(hiddenSet)
    })
  }

  const toggleRunBranchesVisibility = (branchIds: string[]) => {
    if (branchIds.length === 0) {
      return
    }

    setHiddenRunBranchIdsState((prev) => {
      const hiddenSet = new Set(prev)
      const allHidden = branchIds.every((id) => hiddenSet.has(id))

      if (allHidden) {
        branchIds.forEach((id) => hiddenSet.delete(id))
      } else {
        branchIds.forEach((id) => hiddenSet.add(id))
      }

      return Array.from(hiddenSet)
    })
  }

  const toggleRowVisibility = (row: BranchRow) => {
    toggleStepsVisibility(row.steps.map((step) => step.id))
    if (runTokenIndex >= 0) {
      toggleRunBranchesVisibility([row.branchId])
    }
  }

  const toggleColumnVisibility = (columnIndex: number) => {
    toggleStepsVisibility(displayedSteps.filter((step) => step.index === columnIndex).map((step) => step.id))
  }

  const updatePanel = (id: string, patch: Partial<EntityPanel>) => {
    setEntityPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, ...patch } : panel)))
  }

  const updateViewTargetField = (field: PositionField, value: string) => {
    if (field === 'x') {
      setViewTargetX(value)
      return
    }
    if (field === 'y') {
      setViewTargetY(value)
      return
    }
    setViewTargetZ(value)
  }

  const normalizeViewTargetField = (field: PositionField) => {
    if (field === 'x') {
      setViewTargetX((prev) => normalizeNumericString(prev))
      return
    }
    if (field === 'y') {
      setViewTargetY((prev) => normalizeNumericString(prev))
      return
    }
    setViewTargetZ((prev) => normalizeNumericString(prev))
  }


  const handleSaveToClipboard = async () => {
    try {
      const payload = createSerializedAppState({
        command,
        entityPanels,
        viewMarkerSize,
        viewMarkerOpacity,
        viewTargetSelection,
        viewTargetCoords: {
          x: parseNumberOrZero(viewTargetX),
          y: parseNumberOrZero(viewTargetY),
          z: parseNumberOrZero(viewTargetZ),
        },
        macroArgsInput,
        sidePanelWidth,
        viewOptionsWidth,
        commandPanelHeight,
        hiddenStepIds,
        hiddenRunBranchIds,
      })

      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setSaveLoadStatus({ tone: 'success', message: 'Copied current state to clipboard.' })
    } catch {
      setSaveLoadStatus({ tone: 'error', message: 'Failed to write JSON to clipboard.' })
    }
  }

  const handleLoadFromClipboard = async () => {
    try {
      const raw = await navigator.clipboard.readText()
      const restored = parseSerializedAppState(JSON.parse(raw), {
        maxMarkerSize: MAX_MARKER_SIZE,
        minSidePanelWidth: MIN_ENTITIES_PANEL_WIDTH,
        minViewOptionsWidth: MIN_VIEW_OPTIONS_WIDTH,
        minCommandPanelHeight: 120,
      })

      setCommand(restored.command)
      setCommandCursor(restored.command.length)
      setEntityPanels(restored.entityPanels)
      setViewMarkerSize(restored.viewMarkerSize)
      setViewMarkerOpacity(restored.viewMarkerOpacity)
      setViewTargetSelection(restored.viewTargetSelection)
      setViewTargetX(restored.viewTargetX)
      setViewTargetY(restored.viewTargetY)
      setViewTargetZ(restored.viewTargetZ)
      setMacroArgsInput(restored.macroArgsInput)
      setSidePanelWidth(restored.sidePanelWidth)
      setViewOptionsWidth(restored.viewOptionsWidth)
      setCommandPanelHeight(restored.commandPanelHeight)
      setHiddenStepIdsState(restored.hiddenStepIds)
      setHiddenRunBranchIdsState(restored.hiddenRunBranchIds)
      setSaveLoadStatus({ tone: 'success', message: 'Loaded state from clipboard JSON.' })
    } catch {
      setSaveLoadStatus({ tone: 'error', message: 'Failed to load JSON from clipboard.' })
    }
  }

  const startSpinDrag = (
    event: ReactMouseEvent<HTMLButtonElement>,
    panel: EntityPanel,
    field: NumericField,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const startY = event.clientY
    const startValue = parseNumberOrZero(panel[field])
    const baseStep = SPIN_STEP_BY_FIELD[field]
    const pixelsPerStep = 12

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSteps = (startY - moveEvent.clientY) / pixelsPerStep
      const speed = moveEvent.shiftKey ? 10 : moveEvent.altKey ? 0.1 : 1
      const magnitude = Math.abs(deltaSteps)
      const acceleratedSteps = Math.sign(deltaSteps) * (magnitude + (magnitude * magnitude * 0.2))
      const nextValue = startValue + (acceleratedSteps * baseStep * speed)
      const rounded = Math.round(nextValue * 1000) / 1000
      updatePanel(panel.id, { [field]: normalizePanelFieldString(field, rounded.toString()) } as Partial<EntityPanel>)
    }

    const stopDragging = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopDragging)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect

      setEntityPanels((prev) =>
        prev.map((candidate) => {
          if (candidate.id !== panel.id) {
            return candidate
          }

          if (field === 'height' || field === 'width' || field === 'eyeHeight') {
            return {
              ...candidate,
              ...normalizeEntityDimensionFields(
                field === 'height' ? normalizePanelFieldString(field, candidate[field]) : candidate.height,
                field === 'width' ? normalizePanelFieldString(field, candidate[field]) : candidate.width,
                field === 'eyeHeight' ? normalizePanelFieldString(field, candidate[field]) : candidate.eyeHeight,
              ),
            }
          }

          return { ...candidate, [field]: normalizePanelFieldString(field, candidate[field]) }
        }),
      )
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopDragging)
  }

  const startViewTargetSpinDrag = (
    event: ReactMouseEvent<HTMLButtonElement>,
    field: PositionField,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const startY = event.clientY
    const startValue = parseNumberOrZero(field === 'x' ? viewTargetX : field === 'y' ? viewTargetY : viewTargetZ)
    const baseStep = SPIN_STEP_BY_FIELD[field]
    const pixelsPerStep = 12

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSteps = (startY - moveEvent.clientY) / pixelsPerStep
      const speed = moveEvent.shiftKey ? 10 : moveEvent.altKey ? 0.1 : 1
      const magnitude = Math.abs(deltaSteps)
      const acceleratedSteps = Math.sign(deltaSteps) * (magnitude + (magnitude * magnitude * 0.2))
      const nextValue = startValue + (acceleratedSteps * baseStep * speed)
      const rounded = Math.round(nextValue * 1000) / 1000
      updateViewTargetField(field, rounded.toString())
    }

    const stopDragging = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopDragging)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      normalizeViewTargetField(field)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopDragging)
  }

  const toggleMarkerVisibility = (id: string) => {
    setEntityPanels((prev) =>
      prev.map((panel) =>
        panel.id === id ? { ...panel, markerVisible: !panel.markerVisible } : panel,
      ),
    )
  }

  const addPanel = () => {
    setEntityPanels((prev) => [...prev, createPanel(createPanelId(), createDefaultEntityName(prev))])
  }

  const removePanel = (id: string) => {
    setEntityPanels((prev) => prev.filter((panel) => panel.id !== id))
    if (viewTargetSelection === VIEW_TARGET_ENTITY_PREFIX + id) {
      setViewTargetSelection('coords')
    }
  }

  const dropOnPanel = (targetId: string) => {
    if (!draggedPanelId || draggedPanelId === targetId) {
      return
    }
    setEntityPanels((prev) => reorderPanels(prev, draggedPanelId, targetId))
    setDraggedPanelId(null)
  }

  const reorderOnDragOver = (targetId: string) => {
    if (!draggedPanelId || draggedPanelId === targetId) {
      return
    }
    setEntityPanels((prev) => reorderPanels(prev, draggedPanelId, targetId))
  }

  return (
    <div className="app-root" ref={appRootRef}>
      <header className="top-bar">
        <div className="top-bar-head">
          <label htmlFor="command" className="top-label">
            Execute Visualizer
          </label>
          <div className="top-actions">
            {saveLoadStatus && <span className={`top-status ${saveLoadStatus.tone}`}>{saveLoadStatus.message}</span>}
            <span className="top-credit">
              Developed by{' '}
              <a
                href="https://x.com/komaramune"
                className="top-credit-link"
                target="_blank"
                rel="noreferrer"
              >
                komaramune
              </a>
            </span>
            <button type="button" className="top-action-btn" onClick={handleSaveToClipboard}>
              Save
            </button>
            <button type="button" className="top-action-btn" onClick={handleLoadFromClipboard}>
              Load
            </button>
          </div>
        </div>
        <div className="command-input-wrap">
<textarea
  id="command"
  ref={commandInputRef}
  className="command-input"
  value={command}
  onChange={(event) => {
    setCommand(event.target.value)
    updateCommandCursor(event.target.selectionStart)
  }}
  onFocus={() => {
    setIsCommandFocused(true)
    updateCommandCursor(commandInputRef.current?.selectionStart)
  }}
  onClick={(event) => updateCommandCursor(event.currentTarget.selectionStart)}
  onKeyUp={(event) => updateCommandCursor(event.currentTarget.selectionStart)}
  onSelect={(event) => updateCommandCursor(event.currentTarget.selectionStart)}
  onKeyDown={(event) => {
    if (!showCommandCompletions) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveCompletionIndex((prev) =>
        (prev + 1) % commandCompletions.length
      )
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveCompletionIndex((prev) =>
        prev === 0 ? commandCompletions.length - 1 : prev - 1
      )
      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      applyCommandCompletion(commandCompletions[boundedActiveCompletionIndex])
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setIsCommandFocused(false)
    }
  }}
  placeholder="execute ~"
  spellCheck={false}
/>
          {showCommandCompletions && (
            <div className="command-completion-list" role="listbox" aria-label="Command completions">
              {commandCompletions.map((completion, index) => (
                <button
                  key={`${completion.label}-${completion.insertText}`}
                  type="button"
                  className={`command-completion-item${index === boundedActiveCompletionIndex ? ' active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applyCommandCompletion(completion)
                  }}
                >
                  <span className="command-completion-label">{completion.label}</span>
                  {completion.detail && <span className="command-completion-detail">{completion.detail}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

      </header>

      <main
        ref={contentLayoutRef}
        className="content-layout"
        style={{ gridTemplateColumns: `minmax(0, 1fr) 8px ${effectiveSidePanelWidth}px` }}
      >
        <section
          ref={viewerPanelRef}
          className="viewer-panel"
          style={{ '--viewer-options-width': `${effectiveViewOptionsWidth}px` } as CSSProperties}
        >
          <div
            className={`viewer-panel-resizer panel-resizer${isResizingViewOptions ? ' active' : ''}`}
            onMouseDown={() => setIsResizingViewOptions(true)}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize view options panel"
          />
          <div className={`viewer-side-stack side-panel${isViewerSideCollapsed ? ' collapsed' : ''}`}>
            <ViewOptionsPanel
              collapsed={isViewerSideCollapsed}
              onToggleCollapsed={() => setIsViewerSideCollapsed((prev) => !prev)}
              maxMarkerSize={MAX_MARKER_SIZE}
              markerSize={viewMarkerSize}
              markerOpacity={viewMarkerOpacity}
              targetSelection={viewTargetSelection}
              entityPanels={entityPanels}
              targetX={viewTargetX}
              targetY={viewTargetY}
              targetZ={viewTargetZ}
              onMarkerSizeChange={setViewMarkerSize}
              onMarkerOpacityChange={setViewMarkerOpacity}
              onTargetSelectionChange={setViewTargetSelection}
              onUpdateTargetField={updateViewTargetField}
              onNormalizeTargetField={normalizeViewTargetField}
              onStartTargetSpinDrag={startViewTargetSpinDrag}
            />
            {!isViewerSideCollapsed && <MacroArgsPanel value={macroArgsInput} onChange={setMacroArgsInput} />}
          </div>
          {activeEntity ? (
            <ThreeViewer
              entity={activeEntity}
              entities={visibleEntities}
              steps={displayedSteps}
              runStates={runMarkerStates}
              highlightedStepId={hoveredStepId}
              highlightedEntityId={hoveredEntityPanelId}
              highlightedStepIds={headerHighlightedStepIds}
              highlightedRunBranchId={hoveredRunBranchId ?? hoveredRowBranchId}
              highlightedRunAll={hoveringRunColumn || hoveringRoot}
              hiddenRunBranchIds={hiddenRunBranchIds}
              hiddenStepIds={hiddenStepIds}
              markerSizeMultiplier={markerSizeMultiplier}
              markerOpacity={markerOpacity}
              cameraTarget={cameraTarget}
              selectorVisualization={selectorVisualization}
            />
          ) : (
            <div className="viewer-empty">No entities</div>
          )}
        </section>

        <div
          className={`panel-resizer${isResizingSidePanel ? ' active' : ''}`}
          onMouseDown={() => setIsResizingSidePanel(true)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize entities panel"
        />

        <aside className={`side-panel entity-side-panel${isEntitiesCollapsed ? ' collapsed' : ''}`}>
          <div className="entity-head panel-toggle-head">
            <div className="panel-head-title">
              <h2>Entities</h2>
              <PanelCollapseButton
                axis="horizontal"
                collapsed={isEntitiesCollapsed}
                onClick={() => setIsEntitiesCollapsed((prev) => !prev)}
              />
            </div>
            <div className="panel-head-actions">
              <button type="button" className="mini-btn" onClick={addPanel}>
                + Add
              </button>
            </div>
          </div>

          {!isEntitiesCollapsed && (
            <div className="entity-list">
              {entityPanels.map((panel) => (
                <EntityPanelCard
                  key={panel.id}
                  panel={panel}
                  onHoverEnter={setHoveredEntityPanelId}
                  onHoverLeave={(id) => setHoveredEntityPanelId((current) => (current === id ? null : current))}
                  onReorderOver={reorderOnDragOver}
                  onDropOn={dropOnPanel}
                  onDragStart={setDraggedPanelId}
                  onDragEnd={() => setDraggedPanelId(null)}
                  onUpdatePanel={updatePanel}
                  onToggleMarkerVisibility={toggleMarkerVisibility}
                  onRemovePanel={removePanel}
                  onStartSpinDrag={startSpinDrag}
                />
              ))}
            </div>
          )}
        </aside>
      </main>

      {!isCommandTreeCollapsed && (
        <div
          className={`command-panel-resizer${isResizingCommandPanel ? ' active' : ''}`}
          onMouseDown={() => setIsResizingCommandPanel(true)}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize subcommand list"
        />
      )}

      <CommandBranchTree
        commandPanelHeight={commandPanelHeight}
        collapsed={isCommandTreeCollapsed}
        onToggleCollapsed={() => setIsCommandTreeCollapsed((prev) => !prev)}
        subcommandTexts={subcommandTexts}
        branchRows={branchRows}
        runTokenIndex={runTokenIndex}
        hiddenStepIds={hiddenStepIds}
        hiddenRunBranchIds={hiddenRunBranchIds}
        hoveredStepId={hoveredStepId}
        hoveredRunBranchId={hoveredRunBranchId}
        hoveredRowBranchId={hoveredRowBranchId}
        hoveredColumnIndex={hoveredColumnIndex}
        hoveringRunColumn={hoveringRunColumn}
        hoveredState={hoveredState}
        hoverTooltip={hoverTooltip}
        allEntities={allEntities}
        visibleParseError={visibleParseError}
        onClearHoverState={() => {
          setHoveredStepId(null)
          setHoveredSelectorPreview(null)
          setHoveredRunBranchId(null)
          setHoveringRoot(false)
          setHoveredRowBranchId(null)
          setHoveredColumnIndex(null)
          setHoveringRunColumn(false)
          setHoverTooltip(null)
        }}
        onSetHoveredStepId={setHoveredStepId}
        onSetHoveredSelectorPreview={setHoveredSelectorPreview}
        onSetHoveredRunBranchId={setHoveredRunBranchId}
        onSetHoveredRowBranchId={setHoveredRowBranchId}
        onSetHoveredColumnIndex={setHoveredColumnIndex}
        onSetHoveringRunColumn={setHoveringRunColumn}
        onSetHoveringRoot={setHoveringRoot}
        onSetHoverTooltip={setHoverTooltip}
        onToggleAll={handleToggleAll}
        onToggleColumnVisibility={toggleColumnVisibility}
        onToggleAllRunVisibility={toggleAllRunVisibility}
        onToggleRowVisibility={toggleRowVisibility}
        onToggleStepVisibility={toggleStepVisibility}
        onToggleRunVisibility={toggleRunVisibility}
      />

    </div>
  )
}

export default App


















































