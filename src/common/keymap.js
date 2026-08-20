// ============================================================================
// 物理键码(DOM code) -> CDP Input.dispatchKeyEvent 参数映射
// 对应计划书 2.4 键盘输入设计。
// BetterGI 下发 physicalCode(如 "KeyW") 与 virtualKey(Windows VK)，
// 扩展据此补全 CDP 需要的 code / key / text / windowsVirtualKeyCode。
// ============================================================================

// Windows Virtual-Key Code 常量（常用集合）
const VK = {
  BACK: 0x08, TAB: 0x09, RETURN: 0x0d, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12,
  ESCAPE: 0x1b, SPACE: 0x20, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
};

/**
 * 根据 DOM code 生成基础键信息。
 * 返回 { key, text, windowsVirtualKeyCode }。text 仅可打印字符使用。
 */
export function resolveKey(code, virtualKey) {
  const c = String(code || '');

  // 字母键 KeyA..KeyZ
  if (/^Key[A-Z]$/.test(c)) {
    const letter = c.slice(3).toLowerCase();
    return {
      key: letter,
      text: letter,
      windowsVirtualKeyCode: virtualKey || letter.toUpperCase().charCodeAt(0),
    };
  }

  // 数字键 Digit0..Digit9（主键盘）
  if (/^Digit[0-9]$/.test(c)) {
    const d = c.slice(5);
    return { key: d, text: d, windowsVirtualKeyCode: virtualKey || d.charCodeAt(0) };
  }

  // 小键盘 Numpad0..Numpad9
  if (/^Numpad[0-9]$/.test(c)) {
    const d = c.slice(6);
    return { key: d, text: d, windowsVirtualKeyCode: virtualKey || (0x60 + Number(d)) };
  }

  switch (c) {
    case 'Space': return { key: ' ', text: ' ', windowsVirtualKeyCode: virtualKey || VK.SPACE };
    case 'Enter': case 'NumpadEnter':
      return { key: 'Enter', text: '\r', windowsVirtualKeyCode: virtualKey || VK.RETURN };
    case 'Escape': return { key: 'Escape', text: '', windowsVirtualKeyCode: virtualKey || VK.ESCAPE };
    case 'Tab': return { key: 'Tab', text: '\t', windowsVirtualKeyCode: virtualKey || VK.TAB };
    case 'Backspace': return { key: 'Backspace', text: '', windowsVirtualKeyCode: virtualKey || VK.BACK };
    case 'ShiftLeft': case 'ShiftRight':
      return { key: 'Shift', text: '', windowsVirtualKeyCode: virtualKey || VK.SHIFT };
    case 'ControlLeft': case 'ControlRight':
      return { key: 'Control', text: '', windowsVirtualKeyCode: virtualKey || VK.CONTROL };
    case 'AltLeft': case 'AltRight':
      return { key: 'Alt', text: '', windowsVirtualKeyCode: virtualKey || VK.MENU };
    case 'ArrowLeft': return { key: 'ArrowLeft', text: '', windowsVirtualKeyCode: virtualKey || VK.LEFT };
    case 'ArrowUp': return { key: 'ArrowUp', text: '', windowsVirtualKeyCode: virtualKey || VK.UP };
    case 'ArrowRight': return { key: 'ArrowRight', text: '', windowsVirtualKeyCode: virtualKey || VK.RIGHT };
    case 'ArrowDown': return { key: 'ArrowDown', text: '', windowsVirtualKeyCode: virtualKey || VK.DOWN };
    default:
      // 兜底：无法识别时不提供 text，仅透传 virtualKey。
      return { key: c || '', text: '', windowsVirtualKeyCode: virtualKey || 0 };
  }
}

/** 是否为「移动类」按键：仅需 rawKeyDown/keyUp，不发送 char（计划书 2.4）。 */
export function isMovementKey(code) {
  return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD';
}

/** CDP 鼠标按钮字段与按位掩码。 */
export const MouseButton = Object.freeze({
  left: { name: 'left', mask: 1 },
  right: { name: 'right', mask: 2 },
  middle: { name: 'middle', mask: 4 },
});
