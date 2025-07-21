/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    isValidAuthFollowUpType,
    INSERT_TO_CURSOR_POSITION,
    AUTH_FOLLOW_UP_CLICKED,
    CHAT_OPTIONS,
    COPY_TO_CLIPBOARD,
    AuthFollowUpType,
    DISCLAIMER_ACKNOWLEDGED,
    UiMessageResultParams,
    CHAT_PROMPT_OPTION_ACKNOWLEDGED,
    ChatPromptOptionAcknowledgedMessage,
    STOP_CHAT_RESPONSE,
    StopChatResponseMessage,
    OPEN_FILE_DIALOG,
} from '@aws/chat-client-ui-types'
import {
    ChatResult,
    chatRequestType,
    ChatParams,
    followUpClickNotificationType,
    quickActionRequestType,
    QuickActionResult,
    QuickActionParams,
    insertToCursorPositionNotificationType,
    ErrorCodes,
    ResponseError,
    openTabRequestType,
    getSerializedChatRequestType,
    listConversationsRequestType,
    conversationClickRequestType,
    listMcpServersRequestType,
    mcpServerClickRequestType,
    ShowSaveFileDialogRequestType,
    ShowSaveFileDialogParams,
    LSPErrorCodes,
    tabBarActionRequestType,
    ShowDocumentParams,
    ShowDocumentResult,
    ShowDocumentRequest,
    contextCommandsNotificationType,
    ContextCommandParams,
    openFileDiffNotificationType,
    OpenFileDiffParams,
    LINK_CLICK_NOTIFICATION_METHOD,
    LinkClickParams,
    INFO_LINK_CLICK_NOTIFICATION_METHOD,
    READY_NOTIFICATION_METHOD,
    buttonClickRequestType,
    ButtonClickResult,
    CancellationTokenSource,
    chatUpdateNotificationType,
    ChatUpdateParams,
    chatOptionsUpdateType,
    ChatOptionsUpdateParams,
    listRulesRequestType,
    ruleClickRequestType,
    pinnedContextNotificationType,
    activeEditorChangedNotificationType,
    ShowOpenDialogRequestType,
    ShowOpenDialogParams,
    openFileDialogRequestType,
    OpenFileDialogResult,
} from '@aws/language-server-runtimes/protocol'
import { v4 as uuidv4 } from 'uuid'
import * as vscode from 'vscode'
import { Disposable, LanguageClient, Position, TextDocumentIdentifier } from 'vscode-languageclient'
import { AmazonQChatViewProvider } from './webviewProvider'
import { AuthUtil, ReferenceLogViewProvider } from 'aws-core-vscode/codewhisperer'
import { AmazonQPromptSettings, messages, openUrl, isTextEditor } from 'aws-core-vscode/shared'
import { DefaultAmazonQAppInitContext, messageDispatcher, referenceLogText } from 'aws-core-vscode/amazonq'
import { telemetry, TelemetryBase } from 'aws-core-vscode/telemetry'
import { isValidResponseError } from './error'
import { decryptResponse, encryptRequest } from '../encryption'
import { focusAmazonQPanel } from './commands'
import { DiffAnimationHandler } from './diffAnimation/diffAnimationHandler'
import { getLogger } from 'aws-core-vscode/shared'
import { getCursorState } from '../utils'

// Create a singleton instance of DiffAnimationHandler
let diffAnimationHandler: DiffAnimationHandler | undefined

export function registerActiveEditorChangeListener(languageClient: LanguageClient) {
    let debounceTimer: NodeJS.Timeout | undefined
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer)
        }
        debounceTimer = setTimeout(() => {
            let textDocument = undefined
            let cursorState = undefined
            if (editor) {
                textDocument = {
                    uri: editor.document.uri.toString(),
                }
                cursorState = getCursorState(editor.selections)
            }
            languageClient.sendNotification(activeEditorChangedNotificationType.method, {
                textDocument,
                cursorState,
            })
        }, 100)
    })
}

export function registerLanguageServerEventListener(languageClient: LanguageClient, provider: AmazonQChatViewProvider) {
    languageClient.info(
        'Language client received initializeResult from server:',
        JSON.stringify(languageClient.initializeResult)
    )

    const chatOptions = languageClient.initializeResult?.awsServerCapabilities?.chatOptions

    // overide the quick action commands provided by flare server initialization, which doesn't provide the group header
    if (chatOptions?.quickActions?.quickActionsCommandGroups?.[0]) {
        chatOptions.quickActions.quickActionsCommandGroups[0].groupName = 'Quick Actions'
    }

    // This passes through metric data from LSP events to Toolkit telemetry with all fields from the LSP server
    languageClient.onTelemetry((e) => {
        const telemetryName: string = e.name

        if (telemetryName in telemetry) {
            languageClient.info(`[VSCode Telemetry] Emitting ${telemetryName} telemetry: ${JSON.stringify(e.data)}`)
            telemetry[telemetryName as keyof TelemetryBase].emit(e.data)
        }
    })
}

// Initialize DiffAnimationHandler on first use
function getDiffAnimationHandler(): DiffAnimationHandler {
    if (!diffAnimationHandler) {
        diffAnimationHandler = new DiffAnimationHandler()
    }
    return diffAnimationHandler
}

// Helper function to clean up temp files - eliminates code duplication
async function cleanupTempFiles(context: string): Promise<void> {
    try {
        const animationHandler = getDiffAnimationHandler()
        const streamingController = (animationHandler as any).streamingDiffController
        if (streamingController && streamingController.cleanupChatSession) {
            await streamingController.cleanupChatSession()
            getLogger().info(`[VSCode Client] 🧹 Cleaned up temp files ${context}`)
        }
    } catch (error) {
        getLogger().warn(`[VSCode Client] ⚠️ Failed to cleanup temp files ${context}: ${error}`)
    }
}

export function registerMessageListeners(
    languageClient: LanguageClient,
    provider: AmazonQChatViewProvider,
    encryptionKey: Buffer
) {
    const chatStreamTokens = new Map<string, CancellationTokenSource>() // tab id -> token

    // **FIXED**: Track streaming sessions by file path to handle fsReplace correctly
    const initializingStreamsByFile = new Map<string, Set<string>>() // filePath -> Set of toolUseIds

    // **IMPROVED**: Track processed chunks with better deduplication logic
    const processedChunks = new Map<string, Set<string>>() // toolUseId -> Set of content hashes

    // Initialize DiffAnimationHandler
    const animationHandler = getDiffAnimationHandler()

    // Keep track of pending chat options to send when webview UI is ready
    const pendingChatOptions = languageClient.initializeResult?.awsServerCapabilities?.chatOptions

    provider.webview?.onDidReceiveMessage(async (message) => {
        languageClient.info(`[VSCode Client]  Received ${JSON.stringify(message)} from chat`)

        if ((message.tabType && message.tabType !== 'cwc') || messageDispatcher.isLegacyEvent(message.command)) {
            // handle the mynah ui -> agent legacy flow
            messageDispatcher.handleWebviewEvent(
                message,
                DefaultAmazonQAppInitContext.instance.getWebViewToAppsMessagePublishers()
            )
            return
        }

        const webview = provider.webview

        switch (message.command) {
            // Handle "aws/chat/ready" event
            case READY_NOTIFICATION_METHOD:
                languageClient.info(`[VSCode Client] "aws/chat/ready" event is received, sending chat options`)
                if (webview && pendingChatOptions) {
                    try {
                        await webview.postMessage({
                            command: CHAT_OPTIONS,
                            params: pendingChatOptions,
                        })

                        // Display a more readable representation of quick actions
                        const quickActionCommands =
                            pendingChatOptions?.quickActions?.quickActionsCommandGroups?.[0]?.commands || []
                        const quickActionsDisplay = quickActionCommands.map((cmd: any) => cmd.command).join(', ')
                        languageClient.info(
                            `[VSCode Client] Chat options flags: mcpServers=${pendingChatOptions?.mcpServers}, history=${pendingChatOptions?.history}, export=${pendingChatOptions?.export}, quickActions=[${quickActionsDisplay}]`
                        )
                        languageClient.sendNotification(message.command, message.params)
                    } catch (err) {
                        languageClient.error(
                            `[VSCode Client] Failed to send CHAT_OPTIONS after "aws/chat/ready" event: ${(err as Error).message}`
                        )
                    }
                }
                break
            case COPY_TO_CLIPBOARD:
                languageClient.info('[VSCode Client] Copy to clipboard event received')
                try {
                    await messages.copyToClipboard(message.params.code)
                } catch (e) {
                    languageClient.error(`[VSCode Client] Failed to copy to clipboard: ${(e as Error).message}`)
                }
                break
            case INSERT_TO_CURSOR_POSITION: {
                const editor = vscode.window.activeTextEditor
                let textDocument: TextDocumentIdentifier | undefined = undefined
                let cursorPosition: Position | undefined = undefined
                if (editor) {
                    cursorPosition = editor.selection.active
                    textDocument = { uri: editor.document.uri.toString() }
                }

                languageClient.sendNotification(insertToCursorPositionNotificationType.method, {
                    ...message.params,
                    cursorPosition,
                    textDocument,
                })
                break
            }
            case AUTH_FOLLOW_UP_CLICKED: {
                languageClient.info('[VSCode Client] AuthFollowUp clicked')
                const authType = message.params.authFollowupType
                const reAuthTypes: AuthFollowUpType[] = ['re-auth', 'missing_scopes']
                const fullAuthTypes: AuthFollowUpType[] = ['full-auth', 'use-supported-auth']

                if (reAuthTypes.includes(authType)) {
                    try {
                        await AuthUtil.instance.reauthenticate()
                    } catch (e) {
                        languageClient.error(
                            `[VSCode Client] Failed to re-authenticate after AUTH_FOLLOW_UP_CLICKED: ${(e as Error).message}`
                        )
                    }
                }

                if (fullAuthTypes.includes(authType)) {
                    try {
                        await AuthUtil.instance.secondaryAuth.deleteConnection()
                    } catch (e) {
                        languageClient.error(
                            `[VSCode Client] Failed to authenticate after AUTH_FOLLOW_UP_CLICKED: ${(e as Error).message}`
                        )
                    }
                }
                break
            }
            case DISCLAIMER_ACKNOWLEDGED: {
                void AmazonQPromptSettings.instance.update('amazonQChatDisclaimer', true)
                break
            }
            case CHAT_PROMPT_OPTION_ACKNOWLEDGED: {
                const acknowledgedMessage = message as ChatPromptOptionAcknowledgedMessage
                switch (acknowledgedMessage.params.messageId) {
                    case 'programmerModeCardId': {
                        void AmazonQPromptSettings.instance.disablePrompt('amazonQChatPairProgramming')
                    }
                }
                break
            }
            case INFO_LINK_CLICK_NOTIFICATION_METHOD:
            case LINK_CLICK_NOTIFICATION_METHOD: {
                const linkParams = message.params as LinkClickParams
                void openUrl(vscode.Uri.parse(linkParams.link))
                break
            }
            case STOP_CHAT_RESPONSE: {
                const tabId = (message as StopChatResponseMessage).params.tabId
                const token = chatStreamTokens.get(tabId)
                token?.cancel()
                token?.dispose()
                chatStreamTokens.delete(tabId)

                // **RACE CONDITION FIX**: Clear any pending initialization locks
                initializingStreamsByFile.clear()

                // **CRITICAL FIX**: Clean up temp files when chat is stopped
                // This ensures temp files are cleaned up when users stop ongoing operations
                await cleanupTempFiles('after stopping chat')
                break
            }
            case chatRequestType.method: {
                const chatParams: ChatParams = { ...message.params }
                const partialResultToken = uuidv4()
                let lastPartialResult: ChatResult | undefined
                const cancellationToken = new CancellationTokenSource()
                chatStreamTokens.set(chatParams.tabId, cancellationToken)

                // **CRITICAL FIX**: Clean up temp files from previous chat sessions
                // This ensures temp files don't accumulate when users start new conversations
                await cleanupTempFiles('before starting new chat')

                const chatDisposable = languageClient.onProgress(
                    chatRequestType,
                    partialResultToken,
                    async (partialResult) => {
                        // Store the latest partial result
                        if (typeof partialResult === 'string' && encryptionKey) {
                            const decoded = await decryptResponse<ChatResult>(partialResult, encryptionKey)
                            lastPartialResult = decoded

                            // Process partial results for diff animations
                            try {
                                await animationHandler.processChatResult(decoded, chatParams.tabId, true)
                            } catch (error) {
                                getLogger().error(`Failed to process partial result for animations: ${error}`)
                            }
                        } else {
                            lastPartialResult = partialResult as ChatResult

                            // Process partial results for diff animations
                            try {
                                await animationHandler.processChatResult(lastPartialResult, chatParams.tabId, true)
                            } catch (error) {
                                getLogger().error(`Failed to process partial result for animations: ${error}`)
                            }
                        }

                        void handlePartialResult<ChatResult>(partialResult, encryptionKey, provider, chatParams.tabId)
                    }
                )

                const editor =
                    vscode.window.activeTextEditor ||
                    vscode.window.visibleTextEditors.find((editor) => editor.document.languageId !== 'Log')
                if (editor) {
                    chatParams.cursorState = getCursorState(editor.selections)
                    chatParams.textDocument = { uri: editor.document.uri.toString() }
                }

                const chatRequest = await encryptRequest<ChatParams>(chatParams, encryptionKey)
                try {
                    const chatResult = await languageClient.sendRequest<string | ChatResult>(
                        chatRequestType.method,
                        {
                            ...chatRequest,
                            partialResultToken,
                        },
                        cancellationToken.token
                    )
                    await handleCompleteResult<ChatResult>(
                        chatResult,
                        encryptionKey,
                        provider,
                        chatParams.tabId,
                        chatDisposable
                    )

                    // Process final result for animations
                    const finalResult =
                        typeof chatResult === 'string' && encryptionKey
                            ? await decryptResponse<ChatResult>(chatResult, encryptionKey)
                            : (chatResult as ChatResult)
                    try {
                        await animationHandler.processChatResult(finalResult, chatParams.tabId, false)
                    } catch (error) {
                        getLogger().error(`Failed to process final result for animations: ${error}`)
                    }
                } catch (e) {
                    const errorMsg = `Error occurred during chat request: ${e}`
                    languageClient.info(errorMsg)
                    languageClient.info(
                        `Last result from langauge server: ${JSON.stringify(lastPartialResult, undefined, 2)}`
                    )
                    if (!isValidResponseError(e)) {
                        throw e
                    }
                    await handleCompleteResult<ChatResult>(
                        e.data,
                        encryptionKey,
                        provider,
                        chatParams.tabId,
                        chatDisposable
                    )
                } finally {
                    chatStreamTokens.delete(chatParams.tabId)
                }
                break
            }
            case OPEN_FILE_DIALOG: {
                // openFileDialog is the event emitted from webView to open
                // file system
                const result = await languageClient.sendRequest<OpenFileDialogResult>(
                    openFileDialogRequestType.method,
                    message.params
                )
                void provider.webview?.postMessage({
                    command: openFileDialogRequestType.method,
                    params: result,
                })
                break
            }
            case quickActionRequestType.method: {
                const quickActionPartialResultToken = uuidv4()
                const quickActionDisposable = languageClient.onProgress(
                    quickActionRequestType,
                    quickActionPartialResultToken,
                    (partialResult) =>
                        handlePartialResult<QuickActionResult>(
                            partialResult,
                            encryptionKey,
                            provider,
                            message.params.tabId
                        )
                )

                const quickActionRequest = await encryptRequest<QuickActionParams>(message.params, encryptionKey)
                const quickActionResult = (await languageClient.sendRequest(quickActionRequestType.method, {
                    ...quickActionRequest,
                    partialResultToken: quickActionPartialResultToken,
                })) as string | ChatResult
                void handleCompleteResult<ChatResult>(
                    quickActionResult,
                    encryptionKey,
                    provider,
                    message.params.tabId,
                    quickActionDisposable
                )
                break
            }
            case listRulesRequestType.method:
            case ruleClickRequestType.method:
            case listConversationsRequestType.method:
            case conversationClickRequestType.method:
            case listMcpServersRequestType.method:
            case mcpServerClickRequestType.method:
            case tabBarActionRequestType.method:
                await resolveChatResponse(message.command, message.params, languageClient, webview)
                break
            case followUpClickNotificationType.method:
                if (!isValidAuthFollowUpType(message.params.followUp.type)) {
                    languageClient.sendNotification(followUpClickNotificationType.method, message.params)
                }
                break
            case buttonClickRequestType.method: {
                const buttonResult = await languageClient.sendRequest<ButtonClickResult>(
                    buttonClickRequestType.method,
                    message.params
                )
                if (!buttonResult.success) {
                    languageClient.error(
                        `[VSCode Client] Failed to execute button action: ${buttonResult.failureReason}`
                    )
                }
                break
            }
            default:
                if (isServerEvent(message.command)) {
                    languageClient.sendNotification(message.command, message.params)
                }
                break
        }
    }, undefined)

    const registerHandlerWithResponseRouter = (command: string) => {
        const handler = async (params: any, _: any) => {
            const mapErrorType = (type: string | undefined): number => {
                switch (type) {
                    case 'InvalidRequest':
                        return ErrorCodes.InvalidRequest
                    case 'InternalError':
                        return ErrorCodes.InternalError
                    case 'UnknownError':
                    default:
                        return ErrorCodes.UnknownErrorCode
                }
            }
            const requestId = uuidv4()

            void provider.webview?.postMessage({
                requestId: requestId,
                command: command,
                params: params,
            })
            const responsePromise = new Promise<UiMessageResultParams | undefined>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    disposable?.dispose()
                    reject(new Error('Request timed out'))
                }, 30000)

                const disposable = provider.webview?.onDidReceiveMessage((message: any) => {
                    if (message.requestId === requestId) {
                        clearTimeout(timeout)
                        disposable?.dispose()
                        resolve(message.params)
                    }
                })
            })

            const result = await responsePromise

            if (result?.success) {
                return result.result
            } else {
                return new ResponseError(
                    mapErrorType(result?.error.type),
                    result?.error.message ?? 'No response from client'
                )
            }
        }

        languageClient.onRequest(command, handler)
    }

    registerHandlerWithResponseRouter(openTabRequestType.method)
    registerHandlerWithResponseRouter(getSerializedChatRequestType.method)

    languageClient.onRequest(ShowSaveFileDialogRequestType.method, async (params: ShowSaveFileDialogParams) => {
        const filters: Record<string, string[]> = {}
        const formatMappings = [
            { format: 'markdown', key: 'Markdown', extensions: ['md'] },
            { format: 'html', key: 'HTML', extensions: ['html'] },
        ]

        for (const format of params.supportedFormats ?? []) {
            const mapping = formatMappings.find((m) => m.format === format)
            if (mapping) {
                filters[mapping.key] = mapping.extensions
            }
        }

        const saveAtUri = params.defaultUri ? vscode.Uri.parse(params.defaultUri) : vscode.Uri.file('export-chat.md')
        const targetUri = await vscode.window.showSaveDialog({
            filters,
            defaultUri: saveAtUri,
            title: 'Export',
        })

        if (!targetUri) {
            return new ResponseError(LSPErrorCodes.RequestFailed, 'Export failed')
        }

        return {
            targetUri: targetUri.toString(),
        }
    })

    languageClient.onRequest(ShowOpenDialogRequestType.method, async (params: ShowOpenDialogParams) => {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: params.canSelectFiles ?? true,
                canSelectFolders: params.canSelectFolders ?? false,
                canSelectMany: params.canSelectMany ?? false,
                filters: params.filters,
                defaultUri: params.defaultUri ? vscode.Uri.parse(params.defaultUri, false) : undefined,
                title: params.title,
            })
            const urisString = uris?.map((uri) => uri.fsPath)
            return { uris: urisString || [] }
        } catch (err) {
            languageClient.error(`[VSCode Client] Failed to open file dialog: ${(err as Error).message}`)
            return { uris: [] }
        }
    })

    languageClient.onRequest<ShowDocumentParams, ShowDocumentResult>(
        ShowDocumentRequest.method,
        async (params: ShowDocumentParams): Promise<ShowDocumentParams | ResponseError<ShowDocumentResult>> => {
            focusAmazonQPanel().catch((e) => languageClient.error(`[VSCode Client] focusAmazonQPanel() failed`))

            try {
                const uri = vscode.Uri.parse(params.uri)

                if (params.external) {
                    // Note: Not using openUrl() because we probably don't want telemetry for these URLs.
                    // Also it doesn't yet support the required HACK below.

                    // HACK: workaround vscode bug: https://github.com/microsoft/vscode/issues/85930
                    vscode.env.openExternal(params.uri as any).then(undefined, (e) => {
                        // TODO: getLogger('?').error('failed vscode.env.openExternal: %O', e)
                        vscode.env.openExternal(uri).then(undefined, (e) => {
                            // TODO: getLogger('?').error('failed vscode.env.openExternal: %O', e)
                        })
                    })
                    return params
                }

                const doc = await vscode.workspace.openTextDocument(uri)
                await vscode.window.showTextDocument(doc, { preview: false })
                return params
            } catch (e) {
                return new ResponseError(
                    LSPErrorCodes.RequestFailed,
                    `Failed to open document: ${(e as Error).message}`
                )
            }
        }
    )

    languageClient.onNotification(contextCommandsNotificationType.method, (params: ContextCommandParams) => {
        void provider.webview?.postMessage({
            command: contextCommandsNotificationType.method,
            params: params,
        })
    })
    languageClient.onNotification(
        pinnedContextNotificationType.method,
        (params: ContextCommandParams & { tabId: string; textDocument?: TextDocumentIdentifier }) => {
            const editor = vscode.window.activeTextEditor
            let textDocument = undefined
            if (editor && isTextEditor(editor)) {
                textDocument = { uri: vscode.workspace.asRelativePath(editor.document.uri) }
            }
            void provider.webview?.postMessage({
                command: pinnedContextNotificationType.method,
                params: { ...params, textDocument },
            })
        }
    )

    languageClient.onNotification(openFileDiffNotificationType.method, async (params: OpenFileDiffParams) => {
        // Normalize the file path
        const normalizedPath = params.originalFileUri.startsWith('file://')
            ? vscode.Uri.parse(params.originalFileUri).fsPath
            : params.originalFileUri

        const originalContent = params.originalFileContent || ''
        const newContent = params.fileContent || ''

        getLogger().info(`[VSCode Client] OpenFileDiff notification for: ${normalizedPath}`)
        getLogger().info(
            `[VSCode Client] Original content length: ${originalContent.length}, New content length: ${newContent.length}`
        )

        // **CRITICAL FIX**: Check if this is a streaming-related notification
        // Streaming notifications often have special markers or identical content
        const animationHandler = getDiffAnimationHandler()

        // Check if the content is identical (which often indicates redundant notification from streaming)
        if (originalContent === newContent) {
            getLogger().info(
                '[VSCode Client] 🚫 Skipping redundant diff view - content is identical (likely from streaming)'
            )
            return
        }

        // **CRITICAL FIX**: Check if this notification contains streaming markers
        // The streaming system sends notifications with special content markers
        if (newContent.includes('<!-- STREAMING_DIFF_START:') || newContent.includes('STREAMING_DIFF_START')) {
            getLogger().info('[VSCode Client] 🌊 Skipping streaming marker notification - handled by streaming system')
            return
        }

        // **CRITICAL FIX**: Check if both contents are empty or very small (likely streaming initialization)
        if (originalContent.length === 0 && newContent.length < 100) {
            getLogger().info('[VSCode Client] 🚫 Skipping likely streaming initialization notification')
            return
        }

        // For legitimate file tab clicks from chat, we should show the static diff view
        getLogger().info('[VSCode Client] File tab clicked from chat, showing static diff view')

        // Use processFileDiff with isFromChatClick=true, which will trigger showVSCodeDiff
        await animationHandler.processFileDiff({
            originalFileUri: params.originalFileUri,
            originalFileContent: originalContent,
            fileContent: newContent,
            isFromChatClick: true, // This ensures it goes to showVSCodeDiff
        })
    })

    languageClient.onNotification(chatUpdateNotificationType.method, async (params: ChatUpdateParams) => {
        // Process fsReplace complete events for line-by-line diff animation
        // if ((params.data as any)?.fsReplaceComplete) {
        //     const fsReplaceComplete = (params.data as any).fsReplaceComplete
        //     try {
        //         getLogger().info(
        //             `[VSCode Client] 🔄 Received fsReplace complete for ${fsReplaceComplete.toolUseId}: ${fsReplaceComplete.diffString?.length || 0} chars`
        //         )

        //         // Process fsReplace complete with StreamingDiffController
        //         const animationHandler = getDiffAnimationHandler()
        //         const streamingController = (animationHandler as any).streamingDiffController
        //         if (streamingController && streamingController.processFsReplaceComplete) {
        //             await streamingController.processFsReplaceComplete(fsReplaceComplete)
        //         } else {
        //             getLogger().warn(
        //                 `[VSCode Client] ⚠️ StreamingDiffController not available for fsReplace processing`
        //             )
        //         }

        //         getLogger().info(`[VSCode Client] ✅ fsReplace complete processed successfully`)
        //     } catch (error) {
        //         getLogger().error(`[VSCode Client] ❌ Failed to process fsReplace complete: ${error}`)
        //     }
        //     // Don't forward fsReplaceComplete to the webview - it's handled by the animation
        //     return
        // }

        // Process streaming chunks for real-time diff animations (fsWrite and fsReplace)
        if ((params.data as any)?.streamingChunk) {
            const streamingChunk = (params.data as any).streamingChunk

            // **NEW: Handle fsReplace streaming chunks separately**
            if (streamingChunk.toolName === 'fsReplace') {
                try {
                    getLogger().info(
                        `[VSCode Client] 🔄 Received fsReplace streaming chunk for ${streamingChunk.toolUseId}: ${streamingChunk.content?.length || 0} chars (complete: ${streamingChunk.isComplete}) command: ${streamingChunk.fsWriteParams?.command}`
                    )

                    // **CORRECTED FIX**: Only deduplicate truly identical chunks, not progressive streaming
                    // For fsReplace_diffPair, each chunk should be processed as they represent different stages
                    // Only skip if we get the EXACT same content hash multiple times in rapid succession
                    const contentHash = streamingChunk.content
                        ? `${streamingChunk.content.substring(0, 50)}-${streamingChunk.content.length}`
                        : 'empty'
                    const chunkHash = `${streamingChunk.toolUseId}-${contentHash}-${streamingChunk.fsWriteParams?.pairIndex || 0}-${streamingChunk.isComplete}`

                    if (!processedChunks.has(streamingChunk.toolUseId)) {
                        processedChunks.set(streamingChunk.toolUseId, new Set())
                    }

                    const toolChunks = processedChunks.get(streamingChunk.toolUseId)!

                    // **CRITICAL FIX**: For fsReplace_diffPair, only skip if we get identical content + completion state
                    // This allows progressive streaming while preventing true duplicates
                    if (streamingChunk.fsWriteParams?.command === 'fsReplace_diffPair') {
                        // For diff pairs, only skip if we get the exact same content AND completion state
                        if (toolChunks.has(chunkHash)) {
                            getLogger().info(
                                `[VSCode Client] 🚫 Skipping duplicate fsReplace diffPair chunk for ${streamingChunk.toolUseId}: ${chunkHash}`
                            )
                            return
                        }
                    } else {
                        // For regular streaming, use the original logic but be more permissive
                        const simpleHash = `${streamingChunk.toolUseId}-${streamingChunk.content?.length || 0}`
                        if (toolChunks.has(simpleHash) && streamingChunk.isComplete) {
                            getLogger().info(
                                `[VSCode Client] 🚫 Skipping duplicate final chunk for ${streamingChunk.toolUseId}: ${simpleHash}`
                            )
                            return
                        }
                        toolChunks.add(simpleHash)
                    }

                    // Mark this chunk as processed
                    toolChunks.add(chunkHash)

                    // **CRITICAL DEBUG**: Log the exact payload received
                    getLogger().info(`[VSCode Client] 📥 RECEIVED DIFF CHUNK PAYLOAD:`)
                    getLogger().info(`[VSCode Client]   toolUseId: ${streamingChunk.toolUseId}`)
                    getLogger().info(`[VSCode Client]   toolName: ${streamingChunk.toolName}`)
                    getLogger().info(`[VSCode Client]   filePath: ${streamingChunk.filePath}`)
                    getLogger().info(
                        `[VSCode Client]   content: "${streamingChunk.content?.substring(0, 100)}${streamingChunk.content && streamingChunk.content.length > 100 ? '...' : ''}"`
                    )
                    getLogger().info(`[VSCode Client]   isComplete: ${streamingChunk.isComplete}`)
                    getLogger().info('[VSCode Client]   fsWriteParams: %O', streamingChunk.fsWriteParams)
                    getLogger().info(`[VSCode Client]   chunkHash: ${chunkHash}`)

                    // Process fsReplace streaming chunk with DiffAnimationHandler
                    const animationHandler = getDiffAnimationHandler()

                    // **CRITICAL FIX**: Use the same mechanism as fsWrite to prevent race conditions
                    // fsWrite uses a try/finally pattern to ensure initialization locks are always cleaned up
                    const filePath = streamingChunk.filePath
                    const isAlreadyInitializing =
                        filePath &&
                        initializingStreamsByFile.has(filePath) &&
                        initializingStreamsByFile.get(filePath)!.has(streamingChunk.toolUseId)

                    if (
                        !animationHandler.isStreamingActive(streamingChunk.toolUseId) &&
                        filePath &&
                        !isAlreadyInitializing
                    ) {
                        // Mark as initializing IMMEDIATELY to prevent race condition
                        if (!initializingStreamsByFile.has(filePath)) {
                            initializingStreamsByFile.set(filePath, new Set())
                        }
                        initializingStreamsByFile.get(filePath)!.add(streamingChunk.toolUseId)

                        try {
                            getLogger().info(
                                `[VSCode Client] 🎬 Initializing fsReplace streaming session for ${streamingChunk.toolUseId} at ${filePath}`
                            )
                            await animationHandler.startStreamingDiffSession(streamingChunk.toolUseId, filePath)
                            getLogger().info(
                                `[VSCode Client] ✅ Successfully initialized fsReplace streaming session for ${streamingChunk.toolUseId}`
                            )
                        } catch (error) {
                            getLogger().error(
                                `[VSCode Client] ❌ Failed to initialize fsReplace streaming session for ${streamingChunk.toolUseId}: ${error}`
                            )
                            // **CRITICAL**: Don't throw error - continue processing the chunk
                            // The animation might still work even if initialization had issues
                            getLogger().warn(
                                `[VSCode Client] ⚠️ Continuing fsReplace processing despite initialization error`
                            )
                        } finally {
                            // **CRITICAL FIX**: Always remove the lock, even if initialization failed
                            // This matches the fsWrite pattern and prevents deadlocks
                            if (filePath && initializingStreamsByFile.has(filePath)) {
                                const toolUseIds = initializingStreamsByFile.get(filePath)!
                                toolUseIds.delete(streamingChunk.toolUseId)
                                if (toolUseIds.size === 0) {
                                    initializingStreamsByFile.delete(filePath)
                                }
                            }
                        }
                    } else if (isAlreadyInitializing) {
                        getLogger().info(
                            `[VSCode Client] 🚫 Skipping duplicate fsReplace streaming session initialization for ${streamingChunk.toolUseId} (already initializing)`
                        )
                    }

                    // **ALWAYS UPDATE PARAMS**: Pass fsReplace parameters to streaming controller for correct phase handling
                    if (streamingChunk.fsWriteParams) {
                        getLogger().info(
                            `[VSCode Client] 📝 Updating fsReplace params for ${streamingChunk.toolUseId}: command=${streamingChunk.fsWriteParams.command}, pairIndex=${streamingChunk.fsWriteParams.pairIndex}, totalPairs=${streamingChunk.fsWriteParams.totalPairs}`
                        )
                        // Access the streaming controller directly to update fsWrite params
                        const streamingController = (animationHandler as any).streamingDiffController
                        if (streamingController && streamingController.updateFsWriteParams) {
                            streamingController.updateFsWriteParams(
                                streamingChunk.toolUseId,
                                streamingChunk.fsWriteParams
                            )
                        }
                    }

                    // **CRITICAL FIX**: Handle fsReplace diff pairs differently from progressive streaming
                    // fsReplace sends complete diff pairs that should trigger immediate animations
                    if (streamingChunk.fsWriteParams?.command === 'fsReplace_diffPair') {
                        getLogger().info(
                            `[VSCode Client] 🎬 Processing fsReplace diff pair ${streamingChunk.fsWriteParams.pairIndex + 1}/${streamingChunk.fsWriteParams.totalPairs}`
                        )

                        // **CRITICAL FIX**: Use the public streamContentUpdate method instead of accessing private fields
                        // The streamingDiffController.streamContentUpdate method already handles fsReplace_diffPair commands
                        await animationHandler.streamContentUpdate(
                            streamingChunk.toolUseId,
                            streamingChunk.content || '',
                            streamingChunk.isComplete || false
                        )
                    } else {
                        // **EXISTING**: Handle progressive streaming (fsWrite style)
                        await animationHandler.streamContentUpdate(
                            streamingChunk.toolUseId,
                            streamingChunk.content || '',
                            streamingChunk.isComplete || false
                        )
                    }

                    // **CRITICAL FIX**: The problem is that each diff pair gets a different toolUseId
                    // But they're all part of the same fsReplace operation on the same file
                    // We need to track completion by FILE PATH, not by individual toolUseId
                    if (streamingChunk.isComplete) {
                        const { pairIndex = 0, totalPairs = 1 } = streamingChunk.fsWriteParams || {}

                        getLogger().info(`[VSCode Client] 🔍 CRITICAL DEBUG: fsReplace chunk analysis:`)
                        getLogger().info(`[VSCode Client]   toolUseId: ${streamingChunk.toolUseId}`)
                        getLogger().info(`[VSCode Client]   filePath: ${streamingChunk.filePath}`)
                        getLogger().info(`[VSCode Client]   pairIndex: ${pairIndex}`)
                        getLogger().info(`[VSCode Client]   totalPairs: ${totalPairs}`)
                        getLogger().info(`[VSCode Client]   isComplete: ${streamingChunk.isComplete}`)

                        // **CRITICAL INSIGHT**: Each diff pair has totalPairs=1 because they're separate operations
                        // The real issue is that the LSP is sending separate fsReplace operations instead of batched diff pairs
                        // For now, treat each complete chunk as individual operations (don't wait for more pairs)

                        getLogger().info(
                            `[VSCode Client] ✅ Individual fsReplace operation complete for ${streamingChunk.toolUseId} (${pairIndex + 1}/${totalPairs}) - treating as standalone operation`
                        )

                        // **RACE CONDITION FIX**: Clean up initialization lock for this specific toolUseId
                        // Since each diff pair is a separate operation with its own toolUseId
                        const filePath = streamingChunk.filePath
                        if (filePath && initializingStreamsByFile.has(filePath)) {
                            const toolUseIds = initializingStreamsByFile.get(filePath)!
                            toolUseIds.delete(streamingChunk.toolUseId)
                            if (toolUseIds.size === 0) {
                                initializingStreamsByFile.delete(filePath)
                            }
                        }
                    } else {
                        getLogger().debug(
                            `[VSCode Client] ⚡ Partial fsReplace streaming chunk processed for ${streamingChunk.toolUseId}`
                        )
                    }
                } catch (error) {
                    getLogger().error(`[VSCode Client] ❌ Failed to process fsReplace streaming chunk: ${error}`)
                    // **CRITICAL**: Clean up initialization lock on error to prevent deadlock
                    initializingStreamsByFile.delete(streamingChunk.toolUseId)
                }
                // Don't forward fsReplace streaming chunks to the webview - they're handled by the animation handler
                return
            }

            // **EXISTING: Handle fsWrite streaming chunks**
            try {
                getLogger().info(
                    `[VSCode Client] 🌊 Received fsWrite streaming chunk for ${streamingChunk.toolUseId}: ${streamingChunk.content?.length || 0} chars (complete: ${streamingChunk.isComplete})`
                )

                // Process streaming chunk with DiffAnimationHandler
                const animationHandler = getDiffAnimationHandler()

                // **RACE CONDITION FIX**: Atomic check-and-create to prevent duplicate initialization
                const filePath = streamingChunk.filePath
                const isAlreadyInitializing =
                    filePath &&
                    initializingStreamsByFile.has(filePath) &&
                    initializingStreamsByFile.get(filePath)!.has(streamingChunk.toolUseId)

                if (
                    !animationHandler.isStreamingActive(streamingChunk.toolUseId) &&
                    filePath &&
                    !isAlreadyInitializing
                ) {
                    // Mark as initializing IMMEDIATELY to prevent race condition
                    if (!initializingStreamsByFile.has(filePath)) {
                        initializingStreamsByFile.set(filePath, new Set())
                    }
                    initializingStreamsByFile.get(filePath)!.add(streamingChunk.toolUseId)

                    try {
                        getLogger().info(
                            `[VSCode Client] 🎬 Initializing streaming session for ${streamingChunk.toolUseId} at ${filePath}`
                        )
                        await animationHandler.startStreamingDiffSession(streamingChunk.toolUseId, filePath)
                        getLogger().info(
                            `[VSCode Client] ✅ Successfully initialized streaming session for ${streamingChunk.toolUseId}`
                        )
                    } catch (error) {
                        getLogger().error(
                            `[VSCode Client] ❌ Failed to initialize streaming session for ${streamingChunk.toolUseId}: ${error}`
                        )
                        throw error
                    } finally {
                        // Always remove the lock, even if initialization failed
                        if (filePath && initializingStreamsByFile.has(filePath)) {
                            const toolUseIds = initializingStreamsByFile.get(filePath)!
                            toolUseIds.delete(streamingChunk.toolUseId)
                            if (toolUseIds.size === 0) {
                                initializingStreamsByFile.delete(filePath)
                            }
                        }
                    }
                } else if (isAlreadyInitializing) {
                    getLogger().info(
                        `[VSCode Client] 🚫 Skipping duplicate streaming session initialization for ${streamingChunk.toolUseId} (already initializing)`
                    )
                }

                // Pass fsWrite parameters to streaming controller for correct region animation
                if (streamingChunk.fsWriteParams) {
                    getLogger().info(
                        `[VSCode Client] 📝 Updating fsWrite params for ${streamingChunk.toolUseId}: command=${streamingChunk.fsWriteParams.command}`
                    )
                    // Access the streaming controller directly to update fsWrite params
                    const streamingController = (animationHandler as any).streamingDiffController
                    if (streamingController && streamingController.updateFsWriteParams) {
                        streamingController.updateFsWriteParams(streamingChunk.toolUseId, streamingChunk.fsWriteParams)
                    }
                }

                await animationHandler.streamContentUpdate(
                    streamingChunk.toolUseId,
                    streamingChunk.content || '',
                    streamingChunk.isComplete || false
                )

                // **CRITICAL FIX**: Add explicit logging for final chunks
                if (streamingChunk.isComplete) {
                    getLogger().info(
                        `[VSCode Client] ✅ FINAL streaming chunk processed for ${streamingChunk.toolUseId} - cleanup should be triggered`
                    )
                    // **RACE CONDITION FIX**: Clean up initialization lock when streaming completes
                    // Note: For fsWrite, we use a simple Set approach since each toolUseId maps to one file
                    const filePath = streamingChunk.filePath
                    if (filePath && initializingStreamsByFile.has(filePath)) {
                        const toolUseIds = initializingStreamsByFile.get(filePath)!
                        toolUseIds.delete(streamingChunk.toolUseId)
                        if (toolUseIds.size === 0) {
                            initializingStreamsByFile.delete(filePath)
                        }
                    }
                } else {
                    getLogger().debug(
                        `[VSCode Client] ⚡ Partial streaming chunk processed for ${streamingChunk.toolUseId}`
                    )
                }
            } catch (error) {
                getLogger().error(`[VSCode Client] ❌ Failed to process streaming chunk: ${error}`)
            }
            // Don't forward streaming chunks to the webview - they're handled by the animation handler
            return
        }

        // **FIX: Don't process chat updates for diff animations here**
        // This was causing duplicate streaming session creation attempts
        // The chatRequestType.method handler already processes partial and final results
        // Only streaming chunks should be processed here, not regular chat messages
        getLogger().debug(`[VSCode Client] 📨 Chat update received (not processing for animations to avoid duplicates)`)

        void provider.webview?.postMessage({
            command: chatUpdateNotificationType.method,
            params: params,
        })
    })

    languageClient.onNotification(chatOptionsUpdateType.method, (params: ChatOptionsUpdateParams) => {
        void provider.webview?.postMessage({
            command: chatOptionsUpdateType.method,
            params: params,
        })
    })
}

// Clean up on extension deactivation
export function dispose() {
    if (diffAnimationHandler) {
        void diffAnimationHandler.dispose()
        diffAnimationHandler = undefined
    }
}

function isServerEvent(command: string) {
    return command.startsWith('aws/chat/') || command === 'telemetry/event'
}

/**
 * Decodes partial chat responses from the language server before sending them to mynah UI
 */
async function handlePartialResult<T extends ChatResult>(
    partialResult: string | T,
    encryptionKey: Buffer | undefined,
    provider: AmazonQChatViewProvider,
    tabId: string
) {
    const decryptedMessage = await decryptResponse<T>(partialResult, encryptionKey)

    if (decryptedMessage.body !== undefined) {
        void provider.webview?.postMessage({
            command: chatRequestType.method,
            params: decryptedMessage,
            isPartialResult: true,
            tabId: tabId,
        })
    }
    return decryptedMessage
}

/**
 * Decodes the final chat responses from the language server before sending it to mynah UI.
 * Once this is called the answer response is finished
 */
async function handleCompleteResult<T extends ChatResult>(
    result: string | T,
    encryptionKey: Buffer | undefined,
    provider: AmazonQChatViewProvider,
    tabId: string,
    disposable: Disposable
) {
    const decryptedMessage = await decryptResponse<T>(result, encryptionKey)

    void provider.webview?.postMessage({
        command: chatRequestType.method,
        params: decryptedMessage,
        tabId: tabId,
    })

    // only add the reference log once the request is complete, otherwise we will get duplicate log items
    for (const ref of decryptedMessage.codeReference ?? []) {
        ReferenceLogViewProvider.instance.addReferenceLog(referenceLogText(ref))
    }
    disposable.dispose()
}

async function resolveChatResponse(
    requestMethod: string,
    params: any,
    languageClient: LanguageClient,
    webview: vscode.Webview | undefined
) {
    const result = await languageClient.sendRequest(requestMethod, params)
    void webview?.postMessage({
        command: requestMethod,
        params: result,
    })
}
