import { getUser } from "../core/page";

let platform = null;

// Persona platform (FUTBIN prices differ between PC and consoles).
export const getUserPlatform = () => {
  if (platform) {
    return platform;
  }
  try {
    const user = getUser();
    const persona =
      user && typeof user.getSelectedPersona === "function" ? user.getSelectedPersona() : null;
    if (persona) {
      platform = persona.isPC ? "pc" : persona.isXbox ? "xbox" : "ps";
      return platform;
    }
  } catch (e) {}
  return "ps";
};
