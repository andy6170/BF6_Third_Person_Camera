/**
 * Standalone third-person camera for Battlefield 6 Portal.
 *
 * Drop this file into a Portal script. It is self-contained: the only dependencies are the `mod` global and the
 * standard Portal event entry points below. Nothing else needs to be imported.
 *
 * It provides:
 *   - the player UI widget used as the aim dot
 *   - the shoulder camera for standing / crouching / prone / sprinting
 *   - the first-person zoom for scoped sniper rifles and launchers
 *   - shoulder switching when the player interacts
 *   - the parallax-corrected aim dot
 *   - the camera reset after leaving a vehicle (works around an engine bug)
 *
 * Public API:
 *   EnableCamera(false) - stop controlling the camera (the aim dot is hidden)
 *   EnableCamera(true)  - start controlling the camera again
 *
 * Note: the event entry points at the bottom are the global functions the game calls. If another file in the same
 * script already defines one of them, merge the two bodies instead of keeping both.
 */

// ---------------------------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------------------------

// The script runs at about 60 Hz. A camera change 33 ms later is not visible, so every tick is fine.
const CAMERA_EVERY_TICKS = 1;

const SHOULDER_LEFT_CAM = -0.45;
const SHOULDER_RIGHT_CAM = 0.35;
const SHOULDER_LEFT_CAM_ZOOM = -0.4;
const SHOULDER_RIGHT_CAM_ZOOM = 0.4;
const SHOULDER_LEFT_UI = mod.CreateVector(12, 5, 0);
const SHOULDER_RIGHT_UI = mod.CreateVector(-12, 5, 0);

// Weapons that zoom into first person instead of the shoulder camera.
const SNIPERS: mod.Weapons[] = [
    mod.Weapons.Sniper_M2010_ESR,
    mod.Weapons.Sniper_Mini_Scout,
    mod.Weapons.Sniper_PSR,
    mod.Weapons.Sniper_SV_98,
    mod.Weapons.Sniper_Interdictor,
    mod.Weapons.Sniper_L115,
];

// Launchers that zoom the same way.
const LAUNCHERS: mod.Gadgets[] = [
    mod.Gadgets.Launcher_Aim_Guided,
    mod.Gadgets.Launcher_Air_Defense,
    mod.Gadgets.Launcher_Auto_Guided,
    mod.Gadgets.Launcher_IGLA,
    mod.Gadgets.Launcher_Unguided_Rocket,
    mod.Gadgets.Launcher_Long_Range,
];

// ---- parallax-corrected aim dot ----
// The zoomed camera sits beside the bullet line, so the point the bullet lands on is off screen centre by an amount
// that depends on the distance. One ray along the aim gives the distance and the dot moves there.
const DOT_RAY_START_M = 1.0;
const DOT_RAY_RANGE_M = 300;        // a miss is treated as a hit this far away
const DOT_CAMERA_BACK_M = 1.0;      // the zoomed third-person camera sits 1 m behind the eye
const DOT_FOV_RAD = 0.8167;         // the third-person camera's fixed vertical field of view (measured)
const DOT_BELOW_M = 0.034;          // the bullet line runs this far below the camera axis
const DOT_UI_HALF_HEIGHT = 540;     // UI units from screen centre to the top edge (1080-high UI)
const DOT_FOCAL_UI = DOT_UI_HALF_HEIGHT / Math.tan(DOT_FOV_RAD / 2);
const DOT_FOR_BOTS = true;         // This is used to simulate players while testing solo for performance
const DOT_MISS_GRACE_TICKS = 30;    // 0.5 s

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

interface CameraPlayerData {
    // UI
    aimWidget: mod.UIWidget | undefined;
    uiCreated: boolean;

    // camera
    active: boolean;                 // false while dead, in a vehicle or on the deploy screen
    alive: boolean;
    stance: string;
    shoulder: string;
    interacting: boolean;
    reloading: boolean;
    sprinting: boolean;
    firstPerson: boolean;
    thirdPerson: boolean;
    hasSniper: boolean;
    hasLauncher: boolean;

    // aim dot
    dotHoldUntil: number;
    dotRayTick: number;
    dotPending: boolean;
    dotEye: mod.Vector | undefined;
    dotFacing: mod.Vector | undefined;
    dotLastHit: number | undefined;
    dotX: number | undefined;
    dotY: number | undefined;
    dotSide: number | undefined;
}

let cameraEnabled = true;
let cameraTicks = 0;

// Players by object id with their data, filled on deploy and emptied on leave, so no lookup happens per tick.
const players = new Map<number, [mod.Player, CameraPlayerData]>();

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

/**
 * Enables or disables the camera system.
 *
 * When disabled the camera tick stops running and every aim dot is hidden. The camera type is deliberately left
 * alone so another mode can take over without a visible jump. Re-enabling makes the camera choices apply again on
 * the next tick.
 */
export function ThirdPersonEnable(enable: boolean): void {
    if (enable === cameraEnabled) return;
    cameraEnabled = enable;

    for (const [, pd] of players.values()) {
        // Force the camera choice to be re-applied when the camera comes back.
        pd.stance = "";
        pd.firstPerson = false;
        pd.thirdPerson = false;
        if (!enable && pd.aimWidget) mod.SetUIWidgetVisible(pd.aimWidget, false);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Player data and UI
// ---------------------------------------------------------------------------------------------------------------

function getPlayerData(player: mod.Player): CameraPlayerData {
    const playerId = mod.GetObjId(player);
    const entry = players.get(playerId);
    if (entry) return entry[1];

    const pd: CameraPlayerData = {
        aimWidget: undefined,
        uiCreated: false,
        active: false,
        alive: false,
        stance: "",
        shoulder: "right",
        interacting: false,
        reloading: false,
        sprinting: false,
        firstPerson: false,
        thirdPerson: false,
        hasSniper: false,
        hasLauncher: false,
        dotHoldUntil: 0,
        dotRayTick: 0,
        dotPending: false,
        dotEye: undefined,
        dotFacing: undefined,
        dotLastHit: undefined,
        dotX: undefined,
        dotY: undefined,
        dotSide: undefined,
    };
    players.set(playerId, [player, pd]);

    return pd;
}

function createPlayerUI(player: mod.Player, pd: CameraPlayerData): void {
    const aimName = "thirdPersonAim_" + mod.GetObjId(player);
    mod.AddUIContainer(
        aimName,
        SHOULDER_RIGHT_UI,
        mod.CreateVector(3, 3, 0),
        mod.UIAnchor.Center,
        mod.GetUIRoot(),
        false,
        0,
        mod.CreateVector(1, 1, 1),
        0.9,
        mod.UIBgFill.Solid,
        mod.UIDepth.AboveGameUI,
        player
    );

    pd.aimWidget = mod.FindUIWidgetWithName(aimName);
    pd.uiCreated = true;
    pd.dotHoldUntil = 0;
    pd.dotX = undefined;
    pd.dotY = undefined;
    pd.dotSide = undefined;
}

function destroyPlayerUI(pd: CameraPlayerData): void {
    if (pd.aimWidget) mod.DeleteUIWidget(pd.aimWidget);
    pd.aimWidget = undefined;
    pd.uiCreated = false;
}

// ---------------------------------------------------------------------------------------------------------------
// Aim dot
// ---------------------------------------------------------------------------------------------------------------

function dotCast(player: mod.Player, pd: CameraPlayerData): void {
    if (!pd.aimWidget || pd.stance === "ADS") return;   // no dot, or a scoped first-person view
    if (!DOT_FOR_BOTS && mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) return;
    if (pd.dotHoldUntil !== undefined && cameraTicks < pd.dotHoldUntil) return;   // hold: no ray, no move

    const eye = mod.GetSoldierState(player, mod.SoldierStateVector.EyePosition);
    const facing = mod.GetSoldierState(player, mod.SoldierStateVector.GetFacingDirection);

    pd.dotEye = eye;
    pd.dotFacing = facing;
    pd.dotRayTick = cameraTicks;
    pd.dotPending = true;

    mod.RayCast(
        player,
        mod.Add(eye, mod.Multiply(facing, DOT_RAY_START_M)),
        mod.Add(eye, mod.Multiply(facing, DOT_RAY_RANGE_M))
    );
}

function dotHit(player: mod.Player, point: mod.Vector | undefined): void {
    const entry = players.get(mod.GetObjId(player));
    if (!entry) return;
    const pd = entry[1];

    // A ray cast before the player died or left a vehicle can resolve afterwards: never move the dot then.
    if (!cameraEnabled || !pd.active) {
        pd.dotPending = false;
        return;
    }
    if (!pd.dotPending) return;
    pd.dotPending = false;
    if (!pd.aimWidget || !pd.dotEye) return;

    if (point) pd.dotLastHit = cameraTicks;
    else if (pd.dotLastHit !== undefined && cameraTicks - pd.dotLastHit < DOT_MISS_GRACE_TICKS) return;

    const depth = (point ? mod.DistanceBetween(pd.dotEye, point) : DOT_RAY_RANGE_M) + DOT_CAMERA_BACK_M;
    const side = pd.shoulder === "left" ? SHOULDER_LEFT_CAM_ZOOM : SHOULDER_RIGHT_CAM_ZOOM;
    const x = Math.round(-DOT_FOCAL_UI * side / depth);
    const y = Math.round(DOT_FOCAL_UI * DOT_BELOW_M / depth);   // UI y grows downward

    if (x === pd.dotX && y === pd.dotY && side === pd.dotSide) return;

    pd.dotX = x;
    pd.dotY = y;
    pd.dotSide = side;

    mod.SetUIWidgetPosition(pd.aimWidget, mod.CreateVector(x, y, 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------------------------

function cameraUpdate(player: mod.Player, pd: CameraPlayerData, full: boolean): void {
    if (!pd.active || pd.interacting) return;

    // IsAlive is read on full ticks only; reading IsInteracting of a player who is not deployed throws.
    if (full) pd.alive = mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
    if (!pd.alive) return;

    if (mod.GetSoldierState(player, mod.SoldierStateBool.IsInteracting)) {
        pd.interacting = true;
        cameraInteract(player, pd);
        return;
    }

    if (full) cameraApply(player, pd);
}

// The only part that waits.
async function cameraInteract(player: mod.Player, pd: CameraPlayerData): Promise<void> {
    const aimWidget = pd.aimWidget;
    await mod.Wait(0.1);

    if (mod.GetSoldierState(player, mod.SoldierStateBool.IsReloading) && !pd.reloading) {
        pd.interacting = false;
        pd.reloading = true;
        await mod.Wait(3);
        pd.reloading = false;
        return;
    } else if (
        !mod.GetSoldierState(player, mod.SoldierStateBool.IsReviving) &&
        !mod.GetSoldierState(player, mod.SoldierStateBool.IsInVehicle) &&
        pd.stance != "ADS"
    ) {
        pd.stance = "changing";
        pd.thirdPerson = false;

        if (pd.shoulder === "left") {
            pd.shoulder = "right";
            if (aimWidget) mod.SetUIWidgetPosition(aimWidget, SHOULDER_RIGHT_UI);
        } else if (pd.shoulder === "right") {
            pd.shoulder = "left";
            if (aimWidget) mod.SetUIWidgetPosition(aimWidget, SHOULDER_LEFT_UI);
        }
    }

    cameraApply(player, pd);
    await mod.Wait(0.033);
    pd.interacting = false;
}

function cameraApply(player: mod.Player, pd: CameraPlayerData): void {
    const aimWidget = pd.aimWidget;
    const cameraPos = pd.shoulder === "left" ? SHOULDER_LEFT_CAM : SHOULDER_RIGHT_CAM;
    const cameraZoom = pd.shoulder === "left" ? SHOULDER_LEFT_CAM_ZOOM : SHOULDER_RIGHT_CAM_ZOOM;

    if (mod.GetSoldierState(player, mod.SoldierStateBool.IsZooming)) {
        const specialWeaponActive =
            (pd.hasSniper && mod.IsInventorySlotActive(player, mod.InventorySlots.PrimaryWeapon)) ||
            (pd.hasLauncher && (
                mod.IsInventorySlotActive(player, mod.InventorySlots.GadgetOne) ||
                mod.IsInventorySlotActive(player, mod.InventorySlots.GadgetTwo)
            ));

        if (!pd.firstPerson && specialWeaponActive) {
            if (aimWidget) mod.SetUIWidgetVisible(aimWidget, false);
            mod.SetCameraTypeForPlayer(player, mod.Cameras.FirstPerson);
            pd.firstPerson = true;
            pd.stance = "ADS";
        } else if (!specialWeaponActive) {
            if (pd.stance == "ADS") {
                mod.SetCameraTypeForPlayer(player, mod.Cameras.ThirdPerson);
            }

            if ((pd.stance != "standing" || pd.interacting) && mod.GetSoldierState(player, mod.SoldierStateBool.IsStanding)) {
                mod.SetThirdPersonCameraPositionForPlayer(player, 1, 0, cameraZoom);
                pd.stance = "standing";
                if (aimWidget) mod.SetUIWidgetVisible(aimWidget, true);
            } else if ((pd.stance != "crouching" || pd.interacting) && mod.GetSoldierState(player, mod.SoldierStateBool.IsCrouching)) {
                mod.SetThirdPersonCameraPositionForPlayer(player, 0.9, -0.15, cameraZoom);
                pd.stance = "crouching";
                if (aimWidget) mod.SetUIWidgetVisible(aimWidget, true);
            } else if ((pd.stance != "prone" || pd.interacting) && mod.GetSoldierState(player, mod.SoldierStateBool.IsProne)) {
                mod.SetThirdPersonCameraPositionForPlayer(player, 0.8, -0.25, cameraZoom);
                pd.stance = "prone";
                if (aimWidget) mod.SetUIWidgetVisible(aimWidget, true);
            }
        }

        dotCast(player, pd);
        pd.firstPerson = true;
        pd.thirdPerson = false;
    } else {
        const isSprinting = mod.GetSoldierState(player, mod.SoldierStateBool.IsSprinting);

        pd.firstPerson = false;
        pd.thirdPerson = true;

        if (isSprinting) {
            if (pd.stance !== "sprinting" || pd.interacting) {
                if (pd.stance === "ADS") {
                    mod.SetCameraTypeForPlayer(player, mod.Cameras.ThirdPerson);
                }
                pd.sprinting = true;
                pd.stance = "sprinting";
                mod.SetThirdPersonCameraPositionForPlayer(player, 2.2, 0, cameraPos);
                if (aimWidget) mod.SetUIWidgetVisible(aimWidget, false);
            }
        } else {
            if (pd.stance !== "3rdperson" || pd.interacting) {
                if (pd.stance === "ADS") {
                    mod.SetCameraTypeForPlayer(player, mod.Cameras.ThirdPerson);
                }
                pd.sprinting = false;
                pd.stance = "3rdperson";
                mod.SetThirdPersonCameraPositionForPlayer(player, 2.5, 0, cameraPos);
                if (aimWidget) mod.SetUIWidgetVisible(aimWidget, false);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Game entry points
// ---------------------------------------------------------------------------------------------------------------

export function OngoingGlobal(): void {
    if (!cameraEnabled) return;

    const full = ++cameraTicks % CAMERA_EVERY_TICKS === 0;
    for (const [player, pd] of players.values()) cameraUpdate(player, pd, full);
}

export function OnPlayerJoinGame(eventPlayer: mod.Player): void {
    getPlayerData(eventPlayer);
}

export function OnPlayerLeaveGame(eventNumber: number): void {
    const entry = players.get(eventNumber);
    if (entry) destroyPlayerUI(entry[1]);
    players.delete(eventNumber);
}

export async function OnPlayerDeployed(eventPlayer: mod.Player): Promise<void> {
    const pd = getPlayerData(eventPlayer);
    players.set(mod.GetObjId(eventPlayer), [eventPlayer, pd]);

    pd.hasLauncher = LAUNCHERS.some(gadget => mod.HasEquipment(eventPlayer, gadget));
    pd.hasSniper = SNIPERS.some(weapon => mod.HasEquipment(eventPlayer, weapon));

    pd.alive = true;
    pd.active = !mod.GetSoldierState(eventPlayer, mod.SoldierStateBool.IsInVehicle);
    // Reset the stance so the camera choices are applied again on the next tick.
    pd.stance = "";
    pd.firstPerson = false;
    pd.thirdPerson = false;

    if (!pd.uiCreated) createPlayerUI(eventPlayer, pd);

    if (!pd.active) return;

    // The game can deploy the third-person camera at the wrong height: force it through first person once.
    await mod.Wait(0.4);
    if (!cameraEnabled || !pd.active || !pd.alive) return;

    mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.FirstPerson);
    if (pd.aimWidget) mod.SetUIWidgetVisible(pd.aimWidget, false);

    await mod.Wait(0.1);
    if (!cameraEnabled || !pd.active || !pd.alive) return;

    if (!mod.GetSoldierState(eventPlayer, mod.SoldierStateBool.IsInVehicle)) {
        mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.ThirdPerson);
    }
}

export function OnPlayerDied(
    eventPlayer: mod.Player,
    eventOtherPlayer: mod.Player,
    eventDeathType: mod.DeathType,
    eventWeaponUnlock: mod.WeaponUnlock
): void {
    const pd = getPlayerData(eventPlayer);
    pd.active = false;
    pd.alive = false;
    pd.stance = "";
    if (pd.aimWidget) mod.SetUIWidgetVisible(pd.aimWidget, false);
    mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.FirstPerson);
}

export function OnPlayerUndeploy(eventPlayer: mod.Player): void {
    const pd = getPlayerData(eventPlayer);
    pd.active = false;
    pd.alive = false;
    pd.stance = "";
    if (pd.aimWidget) mod.SetUIWidgetVisible(pd.aimWidget, false);
}

export function OnRevived(eventPlayer: mod.Player, eventOtherPlayer: mod.Player): void {
    const pd = getPlayerData(eventPlayer);
    pd.active = true;
    pd.alive = true;
    pd.stance = "";
    pd.firstPerson = false;
    pd.thirdPerson = false;

    if (!cameraEnabled) return;
    mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.ThirdPerson);
}

export function OnPlayerEnterVehicle(eventPlayer: mod.Player, eventVehicle: mod.Vehicle): void {
    const pd = getPlayerData(eventPlayer);
    pd.active = false;
    pd.stance = "";
    if (pd.aimWidget) mod.SetUIWidgetVisible(pd.aimWidget, false);
}

export function OnPlayerExitVehicle(eventPlayer: mod.Player, eventVehicle: mod.Vehicle): void {
    // Engine bug workaround: the third-person camera can stay at the vehicle camera height (or in the wrong
    // camera type) after leaving a vehicle. Cycling the camera type forces it to rebuild.
    mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.FirstPerson);
    mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.FirstPerson);
    mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.ThirdPerson);

    const pd = getPlayerData(eventPlayer);
    pd.active = true;
    pd.alive = true;
    // Reset the stance so the camera choices are applied again on the next tick.
    pd.stance = "";
    pd.firstPerson = false;
    pd.thirdPerson = false;
}

export function OnRayCastHit(eventPlayer: mod.Player, eventPoint: mod.Vector, eventNormal: mod.Vector): void {
    dotHit(eventPlayer, eventPoint);
}

export function OnRayCastMissed(eventPlayer: mod.Player): void {
    dotHit(eventPlayer, undefined);
}
