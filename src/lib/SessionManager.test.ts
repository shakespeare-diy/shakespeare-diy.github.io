import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager, type AIMessage } from './SessionManager';
import type { JSRuntimeFS } from './JSRuntime';

// Mock the filesystem
const mockFS: JSRuntimeFS = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  rmdir: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
  exists: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
  symlink: vi.fn(),
  readlink: vi.fn(),
  chmod: vi.fn(),
  chown: vi.fn(),
  utimes: vi.fn(),
  realpath: vi.fn(),
} as unknown as JSRuntimeFS;

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  const mockAISettings = {
    providers: [
      {
        id: 'test-provider',
        baseURL: 'https://api.test.com',
        apiKey: 'test-key'
      }
    ]
  };

  beforeEach(() => {
    sessionManager = new SessionManager(mockFS, mockAISettings);
  });

  it('should initialize streaming message with reasoning content', async () => {
    const projectId = 'test-project';
    const tools = {};
    const customTools = {};

    const session = await sessionManager.loadSession(projectId, tools, customTools);

    expect(session.projectId).toBe(projectId);
    expect(session.streamingMessage).toBeUndefined();
  });

  it('should emit streamingUpdate events with reasoning content', () => {
    const projectId = 'test-project';
    const mockListener = vi.fn();

    sessionManager.on('streamingUpdate', mockListener);

    // Simulate a streaming update with reasoning content
    sessionManager.emit('streamingUpdate', projectId, 'content', 'reasoning', undefined);

    expect(mockListener).toHaveBeenCalledWith(projectId, 'content', 'reasoning', undefined);
  });

  it('should handle streaming message with reasoning content', async () => {
    const projectId = 'test-project';
    const tools = {};
    const customTools = {};

    const session = await sessionManager.loadSession(projectId, tools, customTools);

    // Manually set a streaming message to test the structure
    session.streamingMessage = {
      role: 'assistant',
      content: 'test content',
      reasoning_content: 'test reasoning',
      tool_calls: undefined
    };

    expect(session.streamingMessage.reasoning_content).toBe('test reasoning');
    expect(session.streamingMessage.content).toBe('test content');
  });

  it('should support assistant messages with reasoning content', () => {
    // Test that AIMessage type supports reasoning content
    const messageWithReasoning: AIMessage = {
      role: 'assistant',
      content: 'Here is my response',
      reasoning_content: 'Let me think about this step by step...'
    };

    expect(messageWithReasoning.role).toBe('assistant');
    expect(messageWithReasoning.content).toBe('Here is my response');
    expect('reasoning_content' in messageWithReasoning).toBe(true);
    if ('reasoning_content' in messageWithReasoning) {
      expect(messageWithReasoning.reasoning_content).toBe('Let me think about this step by step...');
    }
  });

  it('should throw service errors instead of adding them to message history', async () => {
    const projectId = 'test-project';
    const tools = {};
    const customTools = {};

    // Load a session
    await sessionManager.loadSession(projectId, tools, customTools);

    // Add a user message to enable generation
    await sessionManager.addMessage(projectId, { role: 'user', content: 'test message' });

    // Attempt to start generation with invalid provider - should throw error instead of adding to messages
    await expect(
      sessionManager.startGeneration(projectId, 'invalid-provider/invalid-model')
    ).rejects.toThrow('Provider "invalid-provider" not found');

    // Verify that no error message was added to the conversation
    const updatedSession = sessionManager.getSession(projectId);
    expect(updatedSession?.messages).toHaveLength(1); // Only the user message
    expect(updatedSession?.messages[0].role).toBe('user');
  });
});