import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CandidateResult, JobSnapshot } from "@/types";

interface StreamState {
  job: JobSnapshot | null;
}

type StreamAction =
  | { type: "snapshot"; job: JobSnapshot }
  | {
      type: "candidate";
      candidate: CandidateResult;
      completed_count: number;
      total_count: number;
    }
  | { type: "progress"; completed_count: number; total_count: number };

function mergeCandidate(
  candidates: CandidateResult[],
  candidate: CandidateResult,
): CandidateResult[] {
  const index = candidates.findIndex((c) => c.id === candidate.id);
  if (index === -1) return [...candidates, candidate];
  const next = candidates.slice();
  next[index] = candidate;
  return next;
}

function reducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "snapshot":
      return { job: action.job };
    case "candidate": {
      if (!state.job) return state;
      return {
        job: {
          ...state.job,
          candidates: mergeCandidate(state.job.candidates, action.candidate),
          completed_count: action.completed_count,
          total_count: action.total_count,
        },
      };
    }
    case "progress": {
      if (!state.job) return state;
      return {
        job: {
          ...state.job,
          completed_count: action.completed_count,
          total_count: action.total_count,
        },
      };
    }
  }
}

function parseMessage<T>(event: MessageEvent): T {
  return JSON.parse(event.data as string) as T;
}

export interface JobStream {
  job: JobSnapshot | null;
  live: boolean;
  streamError: boolean;
  mergeCandidate: (candidate: CandidateResult) => void;
  seedJob: (job: JobSnapshot) => void;
}

export function useJobEvents(jobId: string | null): JobStream {
  const [state, dispatch] = useReducer(reducer, { job: null });
  const [live, setLive] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const countsRef = useRef({ completed_count: 0, total_count: 0 });

  useEffect(() => {
    countsRef.current = {
      completed_count: state.job?.completed_count ?? 0,
      total_count: state.job?.total_count ?? 0,
    };
  }, [state.job]);

  const mergeCandidateAction = useCallback((candidate: CandidateResult) => {
    const counts = countsRef.current;
    dispatch({
      type: "candidate",
      candidate,
      completed_count: counts.completed_count,
      total_count: counts.total_count,
    });
  }, []);

  const seedJob = useCallback((job: JobSnapshot) => {
    dispatch({ type: "snapshot", job });
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const source = new EventSource(`/api/jobs/${jobId}/events`);

    source.addEventListener("snapshot", (event) => {
      const job = parseMessage<JobSnapshot>(event);
      setStreamError(false);
      dispatch({ type: "snapshot", job });
    });
    source.addEventListener("job.progress", (event) => {
      const payload = parseMessage<{
        completed_count: number;
        total_count: number;
      }>(event);
      dispatch({ type: "progress", ...payload });
    });
    source.addEventListener("candidate.updated", (event) => {
      const payload = parseMessage<{
        candidate: CandidateResult;
        completed_count: number;
        total_count: number;
      }>(event);
      dispatch({ type: "candidate", ...payload });
    });
    source.addEventListener("job.complete", (event) => {
      dispatch({ type: "snapshot", job: parseMessage<JobSnapshot>(event) });
      source.close();
      setLive(false);
    });
    source.onopen = () => setLive(true);
    source.onerror = () => {
      // EventSource reconnects automatically; the server resends a snapshot
      // on reconnect so state re-syncs from scratch.
      setLive(false);
      setStreamError(true);
    };

    return () => {
      source.close();
      setLive(false);
    };
  }, [jobId]);

  return {
    job: state.job,
    live,
    streamError,
    mergeCandidate: mergeCandidateAction,
    seedJob,
  };
}
