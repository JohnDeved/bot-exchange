export const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 16 16" shape-rendering="crispEdges">
<path fill="#22382f" d="M2 0h12v1h1v1h1v12h-1v1h-1v1H2v-1H1v-1H0V2h1V1h1z"/>
<path fill="#f6f2e9" d="M4 3h8v1h1v6h-1v1H8v1H7v1H5v-2H4v-1H3V4h1z"/>
<path fill="#22382f" d="M5 6h2v2H5zM9 6h2v2H9z"/>
</svg>\n`;

// Each band adds one cell of a 2×2 ordered pattern; every painted pixel is 2px square.
function ditherRamp(from: string, to: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="80" viewBox="0 0 4 80" shape-rendering="crispEdges">
<defs>
<pattern id="quarter" width="4" height="4" patternUnits="userSpaceOnUse"><path fill="${to}" d="M0 0h2v2H0z"/></pattern>
<pattern id="half" width="4" height="4" patternUnits="userSpaceOnUse"><path fill="${to}" d="M0 0h2v2H0zM2 2h2v2H2z"/></pattern>
<pattern id="three-quarters" width="4" height="4" patternUnits="userSpaceOnUse"><path fill="${to}" d="M0 0h4v2H0zM2 2h2v2H2z"/></pattern>
</defs>
<path fill="${from}" d="M0 0h4v80H0z"/>
<path fill="url(#quarter)" d="M0 16h4v16H0z"/>
<path fill="url(#half)" d="M0 32h4v16H0z"/>
<path fill="url(#three-quarters)" d="M0 48h4v16H0z"/>
<path fill="${to}" d="M0 64h4v16H0z"/>
</svg>\n`;
}

export const forestDither = ditherRamp('#22382f', '#3b5446');
export const paperDither = ditherRamp('#e1e5d8', '#f6f2e9');
