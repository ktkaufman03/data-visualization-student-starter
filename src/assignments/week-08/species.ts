// Categorical slots, assigned to species in a fixed (alphabetical) order.
// Shared by every view so a species is always the same color.
export const SPECIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];

export function speciesColor(species: string, allSpecies: string[]) {
    return SPECIES_COLORS[allSpecies.indexOf(species)] || '#898781';
}
