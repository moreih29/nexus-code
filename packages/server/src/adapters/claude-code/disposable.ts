export interface Disposable {
  dispose(): void
}

export class DisposableStore implements Disposable {
  private readonly _disposables: Disposable[] = []
  private _disposed = false

  add(disposable: Disposable): void {
    if (this._disposed) {
      disposable.dispose()
      return
    }
    this._disposables.push(disposable)
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    for (const d of this._disposables) {
      d.dispose()
    }
    this._disposables.length = 0
  }
}
