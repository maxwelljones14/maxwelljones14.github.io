---
layout: page
title: Diffusion and Graph Neural Networks 
description: Course Project for 10708 probabilistic graphical models
img: assets/img/pgm_gif.gif
importance: 
category: course project
related_publications: false
---

### [[Full Writeup]](/assets/pdf/pgm_final_report.pdf) [[Codebase]](https://github.com/maxwelljones14/DIFUSCO)
Partners: [David Luo](https://www.linkedin.com/in/david-luo-5401491b0/), [Jocelyn Tseng](https://www.linkedin.com/in/jocelyntseng/)

## Idea
In the most basic sense, diffusion is the process of going from some noisy distribution to a structured one. In our case, we are mapping from the noisy distribution of 

$$f(e) = \text{rand}[0, 1]$$

for every edge, to predicting

$$f(e) = \begin{cases} 1 & \text{edge $e$ in the MST} \\ 0 & \text{otherwise} \end{cases}$$

We also consider other tasks, like predicting edges of the shortest path between two nodes and predicting edges of the minimum cut.

## Datasets
We consider random graphs with 50 nodes. Specifically, 50 random points are chosen in a 1 by 1 square, and the edge weight between points $$p_1$$ and $$p_2$$ is the euclidean distance between them on the plane. We train with 16384 random such graphs. 

## Implementation Details
We build off of [DIFUSCO](https://proceedings.neurips.cc/paper_files/paper/2023/file/0ba520d93c3df592c83a611961314c98-Paper-Conference.pdf), a work by [Zhiqing Sun](https://www.cs.cmu.edu/~zhiqings/) for predicting routes in the traveling salesmen problem using diffusion and graph neural networks. Our goal is to use diffusion and graph neural networks to efficiently solve easier graph problems like minimum spanning tree and shortest path between two points

We use [DDIM](https://arxiv.org/abs/2010.02502) for diffusion training, and train an [anisotropic graph neural network](https://graphdeeplearning.github.io/publication/bresson-2018-experimental/) to diffuse random edge probabilites of being in the MST to the true distribution


## Results (refresh page once image is in full view to see gif in full)

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="/assets/img/pgm_gif.gif" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
We are able to succesfully denoise into the MST. Specifically, we take the probability p_e of each edge being in the MST produced by the model, then  normalize it by the edge weight to produce p_e/e, and order edges by this metric. Finally, we run Kruskal's algorithm on this ordering.  
</div>


as a reminder, Kruskal's algorithm goes from smallest to highest edge by our metric and adds it to an MST. If a cycle is produced, the algorithm removes the most recent edge and continues onto the next highest. in the case where the edges are ordered by weight the correct MST is produced with perfect accuracy, but many cycles may have been found. In the case where the first $$n - 1$$ edges the algorithm checks are correct, the MST is found without any cycles being found. We report low cost difference from the MST actual cost, and less cycles found on average than kruskal's algorithm on the edges ordered by weight alone. 


