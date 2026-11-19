export interface PeerSubmission {
  clientNonce: string;
  clientDeviceId: string;
  /** A Claude stdin write has returned successfully. */
  written?: boolean;
}
