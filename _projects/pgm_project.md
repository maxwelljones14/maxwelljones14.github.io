---
layout: page
title: Solving Graph Problems with Diffusion and Graph Neural Networks 
description: Course Project for 10708 probabilistic graphical models
img: assets/img/pgm_gif.gif
importance: 
category: course project
related_publications: false
---

### [[Full Writeup]](/assets/pdf/pgm_final_report.pdf) [[Codebase]](https://github.com/maxwelljones14/DIFUSCO)
Partners: [David Luo](https://www.linkedin.com/in/david-luo-5401491b0/), [Jocelyn Tseng](https://www.linkedin.com/in/jocelyntseng/)

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="/assets/img/pgm_gif.gif" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
    An example of the diffusion process to find the minimum spanning tree in a graph. Here, each edge gets a probability that it is in the minimum spanning tree. At the beginning of the process, these probabilities are random, and the graph neural network (GNN) denoises them into 1 if the edge is in the MST and 0 otherwise (in the optimal case)
</div>


We build off of [DIFUSCO](https://proceedings.neurips.cc/paper_files/paper/2023/file/0ba520d93c3df592c83a611961314c98-Paper-Conference.pdf), a work by [Zhiqing Sun](https://www.cs.cmu.edu/~zhiqings/) for predicting routes in the traveling salesmen problem using diffusion and graph neural networks. Our goal is to use diffusion and graph neural networks to efficiently solve easier graph problems like minimum spanning tree and shortest path between two points

# Implementation

In the most basic sense, diffusion is the process of going from some noisy distribution to a structured one. In our case, we are mapping from the noisy distribution of 

$$f(e) = \text{rand}[0, 1]$$

for every edge, to predicting

$$f(e) = \begin{cases} 1 & \text{edge $e$ in the MST} \\ 0 & \text{otherwise} \end{cases}$$

We also consider other tasks, like predicting edges of the shortest path between two nodes and predicting edges of the minimum cut.