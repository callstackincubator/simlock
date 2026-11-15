/** why: the three flags that gate admission and planning, each changed by one named method, so no other part writes them. */
export class AcquisitionGates {
  #admissionClosed = false;
  // why: apart from #admissionClosed, which also stops the warm pool; an update refuses leases and leaves the pool running.
  #updateHold = false;
  // why: set only by a stop (`settleAcquisitions`), never cleared; unlike maintenance, which a nuke ends, nothing reopens planning after it.
  #stopPlanning = false;
  #maintenanceDepth = 0;

  get admissionClosed(): boolean {
    return this.#admissionClosed;
  }

  get updateHold(): boolean {
    return this.#updateHold;
  }

  get stopPlanning(): boolean {
    return this.#stopPlanning;
  }

  enterMaintenance(): void {
    this.#maintenanceDepth += 1;
    this.#admissionClosed = true;
  }

  leaveMaintenance(): void {
    this.#maintenanceDepth = Math.max(0, this.#maintenanceDepth - 1);
    this.#admissionClosed = this.#maintenanceDepth > 0;
  }

  holdForUpdate(): void {
    this.#updateHold = true;
  }

  releaseUpdateHold(): void {
    this.#updateHold = false;
  }

  stopPlanningForGood(): void {
    this.#stopPlanning = true;
  }
}
