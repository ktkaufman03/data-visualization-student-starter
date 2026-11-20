import * as d3 from 'd3';
import type { CottontailRow } from './types';

// An inclusive [first, last] range of month indexes.
export type MonthRange = [number, number];

// Months are counted from year 0 so a month/year pair is a single slider value.
export const monthIndex = (d: CottontailRow) => d.year * 12 + (d.month - 1);
export const formatMonth = (i: number) => d3.timeFormat("%b %Y")(new Date(Math.floor(i / 12), i % 12));
