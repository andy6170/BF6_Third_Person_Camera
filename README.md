# Third Person Camera for Battlefield Portal

The third person camera allows for all players to have 3rd person enabled.

This is extracted from the Capital Supremacy Experience.
https://github.com/andy6170/Battlefront-Supremacy

Created by andy6170 and TabbedScamper

Tutorial and explanation: https://youtu.be/jHKCPhZuWRw


# Features
- Shoulder swapping
- Dynamic ADS (1st person when aiming with snipers and launchers)
- Stance camera height adjustments
- Parallax ADS rectical
- Compatible with both block and typescript experiences

## Details
 By default the camera is enabled.

 For typescript you will need to integrate this with your existing code.

 For blocks, you can just import this as a script and it will run independantly.

 There is a function "enableThirdPerson" to allow you to enable/disable it at anytime. Particularly useful for cutscenes.

 To use this function in blocks, you will need a JsAction block with all 3 fields filled out.
 - String: main.enableThirdPerson
 - Boolean: true/false
 - Boolean: true/fasle

 **All 3 fields to be filled. otherwise you will get the following error:**

_Provided parameters (String, Boolean) do not match any overload. Function supports the following overloads: (String, AnyType, AnyType)._

<img width="575" height="349" alt="image" src="https://github.com/user-attachments/assets/1da38ce9-5ae0-4403-a90b-a182010eb195" />



# Controller Users

If you are playing with a controller, you will need to assign the interact button.

By default this is not assigned and will not trigger the shoulder swapping.

To fix this: 

- Go into OPTIONS > CONTROLLER > EDIT SETTINGS > Infantry/Passenger Control Mapping

<img width="1914" height="1078" alt="image" src="https://github.com/user-attachments/assets/39760311-5cf6-4142-8d7d-c6e7a99c104c" />

<img width="1805" height="470" alt="image" src="https://github.com/user-attachments/assets/72e42d15-933f-43e8-bfe0-e2befd6353f9" />

- Interact (PRESS) / Quick Upgrade (HOLD) = Assign this to a button. Default would be Square for Playstation or X for Xbox
