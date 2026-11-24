/**
 * The figure shown before there are any: a portable radio, drawn by hand for Hum (it is also the worked
 * example Claude is given, see server/steps/figure.ts). Imports nothing but the format's types.
 */
export const SAMPLE_FIGURE = {
  name: 'portable radio',
  why: 'a song heard on a kitchen table',
  solids: [
    { id: 'body', shape: 'box', from: [-38, -11, 2], to: [38, 11, 40], round: 5, edge: 2.4 },
    { id: 'footL', shape: 'box', from: [-30, -8, 0], to: [-18, 8, 2], round: 2, edge: 0 },
    { id: 'footR', shape: 'box', from: [18, -8, 0], to: [30, 8, 2], round: 2, edge: 0 },
    { id: 'coneL', shape: 'disc', axis: 'y', from: [-34, 11, 7], to: [-10, 13, 31], edge: 1, group: 'speakers', marks: [{ face: 'front', kind: 'ring', box: [0, 0, 1, 1], r: 8 }] },
    { id: 'coneR', shape: 'disc', axis: 'y', from: [10, 11, 7], to: [34, 13, 31], edge: 1, group: 'speakers', marks: [{ face: 'front', kind: 'ring', box: [0, 0, 1, 1], r: 8 }] },
    { id: 'capL', shape: 'disc', axis: 'y', from: [-26, 13, 15], to: [-18, 15, 23], edge: 2, tone: 2, group: 'speakers' },
    { id: 'capR', shape: 'disc', axis: 'y', from: [18, 13, 15], to: [26, 15, 23], edge: 2, tone: 2, group: 'speakers' },
    { id: 'dial', shape: 'box', from: [-7, 11, 20], to: [7, 12.4, 34], round: 1.5, edge: 0.5, bright: true, marks: [{ face: 'front', kind: 'lines', box: [0.18, 0.35, 0.82, 0.65], n: [6, 0] }] },
    { id: 'deck', shape: 'box', from: [-7, 11, 6], to: [7, 12, 16], round: 1.5, edge: 0.4, marks: [{ face: 'front', kind: 'dots', box: [0.2, 0.25, 0.8, 0.75], n: [4, 3], r: 0.7 }] },
    { id: 'key1', shape: 'box', from: [-16, -4, 40], to: [-11, 4, 43], round: 1, edge: 0.7, tone: 1 },
    { id: 'key2', shape: 'box', from: [-9, -4, 40], to: [-4, 4, 43], round: 1, edge: 0.7 },
    { id: 'key3', shape: 'box', from: [-2, -4, 40], to: [3, 4, 43], round: 1, edge: 0.7 },
    { id: 'key4', shape: 'box', from: [5, -4, 40], to: [10, 4, 43], round: 1, edge: 0.7 },
    { id: 'knob', shape: 'disc', from: [20, -5, 40], to: [30, 5, 45], edge: 1, marks: [{ face: 'top', kind: 'line', box: [0.5, 0.55, 0.5, 0.9] }] },
    { id: 'handle', shape: 'tube', path: [[-34, -3, 34], [-34, -3, 55], [34, -3, 55], [34, -3, 34]], r: 1.7, smooth: false },
    { id: 'aerial', shape: 'tube', path: [[33, -8, 39], [52, -8, 82]], r: 0.7 },
    { id: 'tip', shape: 'ball', from: [50.4, -9.6, 80.6], to: [53.6, -6.4, 83.8] },
  ],
  groups: [{ id: 'speakers' }],
  motions: [
    { do: 'ripple', of: ['key1', 'key2', 'key3', 'key4'], by: 'beat', amt: 2.2, lag: 0.25 },
    { do: 'slide', of: ['capL', 'capR'], by: 'kick', amt: 2, axis: 'y' },
    { do: 'spin', of: ['knob'], by: 'energy', amt: 0.5 },
    { do: 'hinge', of: ['aerial', 'tip'], by: 'bass', amt: 7, axis: 'y', pivot: [33, -8, 39] },
  ],
};
