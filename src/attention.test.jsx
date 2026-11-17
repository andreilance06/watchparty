import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAttention } from './attention.js';

describe('live reactions', () => {
  it('persists local visibility, suppresses hidden reactions, and provides static reduced-motion feedback', () => {
    const ref = { current: null };
    vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ media, matches: true, addEventListener() {}, removeEventListener() {} }));
    function Harness() {
      const view = useAttention(ref, true);
      return <><button onClick={() => view.setShowReactions(!view.showReactions)}>Toggle reactions</button><span data-testid="floating">{view.floating.length}</span><div data-testid="notices">{view.notices.map(item => <span key={item.id}>{item.emoji} {item.name}</span>)}</div></>;
    }
    const view = render(<Harness />);
    act(() => { ref.current.setFullscreen({ active: true, chatVisible: true }); ref.current.receiveReaction({ emoji: '🎉', name: 'Sam' }); });
    expect(screen.getByTestId('floating')).toHaveTextContent('0'); expect(screen.getByTestId('notices')).toHaveTextContent('🎉 Sam');
    fireEvent.click(screen.getByText('Toggle reactions'));
    expect(localStorage.getItem('watchparty-live-reactions')).toBe('hidden');
    act(() => ref.current.receiveReaction({ emoji: '👍', name: 'Alex' }));
    expect(screen.getByTestId('notices')).toBeEmptyDOMElement();
    view.unmount(); render(<Harness />);
    act(() => ref.current.receiveReaction({ emoji: '👍', name: 'Alex' }));
    expect(screen.getByTestId('notices')).toBeEmptyDOMElement();
  });
});
