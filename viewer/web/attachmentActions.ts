// What the thread view can do with an attachment, provided by the app (it owns the dialogs).
import { createContext, useContext } from "react";
import type { AttachmentInfo } from "../shared/types.ts";

export interface AttachmentActions {
  onDelete?: (a: AttachmentInfo) => void; // omitted in read-only mode
  onDeletedClick: (a: AttachmentInfo) => void; // explain that the file is gone
}

export const AttachmentActionsContext = createContext<AttachmentActions>({ onDeletedClick: () => {} });
export const useAttachmentActions = () => useContext(AttachmentActionsContext);
