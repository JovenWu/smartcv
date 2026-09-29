import { createContext, useContext } from "react"

import type { Candidate } from "@/types"

export interface CvViewer {
  selected: Candidate | null
  openCv: (candidate: Candidate) => void
  closeCv: () => void
}

export const CvViewerContext = createContext<CvViewer | null>(null)

export function useCvViewer(): CvViewer {
  const ctx = useContext(CvViewerContext)
  if (!ctx) throw new Error("useCvViewer must be used within CvViewerProvider")
  return ctx
}
