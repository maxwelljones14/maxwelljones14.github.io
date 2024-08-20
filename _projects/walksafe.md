---
layout: page
title: WalkSafe
description: App for finding safe walking paths at night
img: assets/img/WalkSafe.jpg
importance: 3
category: fun
---
### [[CodeBase]](https://github.com/jasonchadwick/WalkSafe)

Partners: [Tanvi Bhargava](https://www.linkedin.com/in/tanvi-bhargava-2b23060/), [Jason Chadwick](https://www.linkedin.com/in/jasonchadwick/), [Adrian Kager](https://www.linkedin.com/in/adriankager/)
<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/path.jpg"  title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>



Our goal was to create a program that, given a start and end location, gives a user the
safest timely walking path to their destination. We used Manhatten as a test area since they had
a lot of crime data for us to use.

# Implementation

First, we downloaded all street nodes from OSM, a mapping API. Next, we assigned each node a
value based on the amount of crime in the area, specifically weighting crime intensity via
a function that took in severity of a crime as well as decayed in value deending on distance
from a node. We also only considered crimes within a certain latitude longitude value of a given
node.
From here, given a path, we would then run an A* search on the start and ending nodes, with the
weight of each node being the crime rating we had assigned.

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/Nodes.png" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/Manhatten.jpg" title="example image"   class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
    <b>Left</b>: All nodes used for our A* Search, <b>Right</b>: Heatmap of Manhatten, with red/brighter areas representing more crime
</div>