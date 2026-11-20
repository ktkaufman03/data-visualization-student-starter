import type { ComponentType } from 'react';
import { ResponsivePseudoScatterPlot } from './week-01/ResponsivePseudoScatterPlot';
import { LoadingAndSummarizingData } from './week-02/LoadingAndSummarizingData';
import { Visualizations } from './week-03/Visualizations';
import { UpdatedVisualizations } from './week-04/UpdatedVisualizations';
import { Interaction } from './week-05/Interaction';
import { ProjectV1 } from './week-06/ProjectV1';
import { DistanceFieldWaves } from './week-07/DistanceFieldWaves';
import { ProjectV2 } from './week-08/ProjectV2';

export interface Assignment {
  id: string;
  name: string;
  component: ComponentType;
}

export const assignments: Assignment[] = [
  {
    id: '1',
    name: 'Week 1',
    component: ResponsivePseudoScatterPlot,
  },
  {
    id: '2',
    name: 'Week 2',
    component: LoadingAndSummarizingData
  },
  {
    id: '3',
    name: 'Week 3',
    component: Visualizations
  },
  {
    id: '4',
    name: 'Week 4',
    component: UpdatedVisualizations
  },
  {
    id: '5',
    name: 'Week 5',
    component: Interaction
  },
  {
    id: '6',
    name: 'Week 6',
    component: ProjectV1
  },
  {
    id: '7',
    name: 'Week 7',
    component: DistanceFieldWaves
  },
  {
    id: '8',
    name: 'Week 8',
    component: ProjectV2
  }
];

export const assignmentsMap = new Map(assignments.map((ex) => [ex.id, ex]));

export const defaultAssignment = '8';
