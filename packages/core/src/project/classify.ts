import type { EditOp } from './types';

/**
 * What an edit invalidates. `free`: layout only, nothing regenerates. `voice`: one line's TTS and
 * alignment, then re-flow. `shot`: one plate. `structural`: the variant's structure (C3, Director v2).
 */
export function classifyEdit(op: EditOp): 'free' | 'voice' | 'shot' | 'structural' {
  switch (op.op) {
    case 'setField':
      return op.path === 'format' ? 'structural' : op.path === 'scene' ? 'shot' : 'voice';
    case 'regenerate':
      return op.assetTag.startsWith('plate:') ? 'shot' : 'voice';
    default:
      return 'free';
  }
}
