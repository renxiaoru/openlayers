/**
 * @module ol/source/ImageWMS
 */

import {DEFAULT_WMS_VERSION} from './common.js';

import ImageWrapper from '../Image.js';
import {assert} from '../asserts.js';
import {listen} from '../events.js';
import EventType from '../events/EventType.js';
import {containsExtent, getCenter, getForViewAndSize, getHeight, getWidth} from '../extent.js';
import {assign} from '../obj.js';
import {get as getProjection, transform} from '../proj.js';
import {calculateSourceResolution} from '../reproj.js';
import ImageSource, {defaultImageLoadFunction} from '../source/Image.js';
import WMSServerType from '../source/WMSServerType.js';
import {compareVersions} from '../string.js';
import {appendParams} from '../uri.js';


/**
 * @const
 * @type {import("../size.js").Size}
 */
const GETFEATUREINFO_IMAGE_SIZE = [101, 101];


/**
 * @typedef {Object} Options
 * @property {import("./Source.js").AttributionLike} [attributions] Attributions.
 * @property {null|string} [crossOrigin] The `crossOrigin` attribute for loaded images.  Note that
 * you must provide a `crossOrigin` value if you are using the WebGL renderer or if you want to
 * access pixel data with the Canvas renderer.  See
 * https://developer.mozilla.org/en-US/docs/Web/HTML/CORS_enabled_image for more detail.
 * @property {boolean} [hidpi=true] Use the `ol/Map#pixelRatio` value when requesting
 * the image from the remote server.
 * @property {import("./WMSServerType.js").default|string} [serverType] The type of
 * the remote WMS server: `mapserver`, `geoserver` or `qgis`. Only needed if `hidpi` is `true`.
 * @property {import("../Image.js").LoadFunction} [imageLoadFunction] Optional function to load an image given a URL.
 * @property {Object<string,*>} params WMS request parameters.
 * At least a `LAYERS` param is required. `STYLES` is
 * `''` by default. `VERSION` is `1.3.0` by default. `WIDTH`, `HEIGHT`, `BBOX`
 * and `CRS` (`SRS` for WMS version < 1.3.0) will be set dynamically.
 * @property {import("../proj.js").ProjectionLike} projection Projection.
 * @property {number} [ratio=1.5] Ratio. `1` means image requests are the size of the map viewport, `2` means
 * twice the width and height of the map viewport, and so on. Must be `1` or
 * higher.
 * @property {Array<number>} [resolutions] Resolutions.
 * If specified, requests will be made for these resolutions only.
 * @property {string} url WMS service URL.
 */


/**
 * @classdesc
 * Source for WMS servers providing single, untiled images.
 *
 * @fires ol/source/Image~ImageSourceEvent
 * @api
 */
class ImageWMS extends ImageSource {
  /**
   * @param {Options=} [opt_options] ImageWMS options.
   */
  constructor(opt_options) {

    const options = opt_options || /** @type {Options} */ ({});

    super({
      attributions: options.attributions,
      projection: options.projection,
      resolutions: options.resolutions
    });

    /**
     * @private
     * @type {?string}
     */
    this.crossOrigin_ =
        options.crossOrigin !== undefined ? options.crossOrigin : null;

    /**
     * @private
     * @type {string|undefined}
     */
    this.url_ = options.url;

    /**
     * @private
     * @type {import("../Image.js").LoadFunction}
     */
    this.imageLoadFunction_ = options.imageLoadFunction !== undefined ?
      options.imageLoadFunction : defaultImageLoadFunction;

    /**
     * @private
     * @type {!Object}
     */
    this.params_ = options.params || {};

    /**
     * @private
     * @type {boolean}
     */
    this.v13_ = true;
    this.updateV13_();

    /**
     * @private
     * @type {import("./WMSServerType.js").default|undefined}
     */
    this.serverType_ = /** @type {import("./WMSServerType.js").default|undefined} */ (options.serverType);

    /**
     * @private
     * @type {boolean}
     */
    this.hidpi_ = options.hidpi !== undefined ? options.hidpi : true;

    /**
     * @private
     * @type {import("../Image.js").default}
     */
    this.image_ = null;

    /**
     * @private
     * @type {import("../size.js").Size}
     */
    this.imageSize_ = [0, 0];

    /**
     * @private
     * @type {number}
     */
    this.renderedRevision_ = 0;

    /**
     * @private
     * @type {number}
     */
    this.ratio_ = options.ratio !== undefined ? options.ratio : 1.5;

  }

  /**
   * Return the GetFeatureInfo URL for the passed coordinate, resolution, and
   * projection. Return `undefined` if the GetFeatureInfo URL cannot be
   * constructed.
   * @param {import("../coordinate.js").Coordinate} coordinate Coordinate.
   * @param {number} resolution Resolution.
   * @param {import("../proj.js").ProjectionLike} projection Projection.
   * @param {!Object} params GetFeatureInfo params. `INFO_FORMAT` at least should
   *     be provided. If `QUERY_LAYERS` is not provided then the layers specified
   *     in the `LAYERS` parameter will be used. `VERSION` should not be
   *     specified here.
   * @return {string|undefined} GetFeatureInfo URL.
   * @api
   */
  getGetFeatureInfoUrl(coordinate, resolution, projection, params) {
    if (this.url_ === undefined) {
      return undefined;
    }
    const projectionObj = getProjection(projection);
    const sourceProjectionObj = this.getProjection();

    if (sourceProjectionObj && sourceProjectionObj !== projectionObj) {
      resolution = calculateSourceResolution(sourceProjectionObj, projectionObj, coordinate, resolution);
      coordinate = transform(coordinate, projectionObj, sourceProjectionObj);
    }

    const extent = getForViewAndSize(coordinate, resolution, 0,
      GETFEATUREINFO_IMAGE_SIZE);

    const baseParams = {
      'SERVICE': 'WMS',
      'VERSION': DEFAULT_WMS_VERSION,
      'REQUEST': 'GetFeatureInfo',
      'FORMAT': 'image/png',
      'TRANSPARENT': true,
      'QUERY_LAYERS': this.params_['LAYERS']
    };
    assign(baseParams, this.params_, params);

    const x = Math.floor((coordinate[0] - extent[0]) / resolution);
    const y = Math.floor((extent[3] - coordinate[1]) / resolution);
    baseParams[this.v13_ ? 'I' : 'X'] = x;
    baseParams[this.v13_ ? 'J' : 'Y'] = y;

    return this.getRequestUrl_(
      extent, GETFEATUREINFO_IMAGE_SIZE,
      1, sourceProjectionObj || projectionObj, baseParams);
  }

  /**
   * Get the user-provided params, i.e. those passed to the constructor through
   * the "params" option, and possibly updated using the updateParams method.
   * @return {Object} Params.
   * @api
   */
  getParams() {
    return this.params_;
  }

  /**
   * @inheritDoc
   */
  getImageInternal(extent, resolution, pixelRatio, projection) {

    if (this.url_ === undefined) {
      return null;
    }

    resolution = this.findNearestResolution(resolution);

    if (pixelRatio != 1 && (!this.hidpi_ || this.serverType_ === undefined)) {
      pixelRatio = 1;
    }

    const imageResolution = resolution / pixelRatio;

    const center = getCenter(extent);
    const viewWidth = Math.ceil(getWidth(extent) / imageResolution);
    const viewHeight = Math.ceil(getHeight(extent) / imageResolution);
    const viewExtent = getForViewAndSize(center, imageResolution, 0,
      [viewWidth, viewHeight]);
    const requestWidth = Math.ceil(this.ratio_ * getWidth(extent) / imageResolution);
    const requestHeight = Math.ceil(this.ratio_ * getHeight(extent) / imageResolution);
    const requestExtent = getForViewAndSize(center, imageResolution, 0,
      [requestWidth, requestHeight]);

    const image = this.image_;
    if (image &&
        this.renderedRevision_ == this.getRevision() &&
        image.getResolution() == resolution &&
        image.getPixelRatio() == pixelRatio &&
        containsExtent(image.getExtent(), viewExtent)) {
      return image;
    }

    const params = {
      'SERVICE': 'WMS',
      'VERSION': DEFAULT_WMS_VERSION,
      'REQUEST': 'GetMap',
      'FORMAT': 'image/png',
      'TRANSPARENT': true
    };
    assign(params, this.params_);

    this.imageSize_[0] = Math.round(getWidth(requestExtent) / imageResolution);
    this.imageSize_[1] = Math.round(getHeight(requestExtent) / imageResolution);

    const url = this.getRequestUrl_(requestExtent, this.imageSize_, pixelRatio,
      projection, params);

    this.image_ = new ImageWrapper(requestExtent, resolution, pixelRatio,
      url, this.crossOrigin_, this.imageLoadFunction_);

    this.renderedRevision_ = this.getRevision();

    listen(this.image_, EventType.CHANGE,
      this.handleImageChange, this);

    return this.image_;

  }

  /**
   * Return the image load function of the source.
   * @return {import("../Image.js").LoadFunction} The image load function.
   * @api
   */
  getImageLoadFunction() {
    return this.imageLoadFunction_;
  }

  /**
   * @param {import("../extent.js").Extent} extent Extent.
   * @param {import("../size.js").Size} size Size.
   * @param {number} pixelRatio Pixel ratio.
   * @param {import("../proj/Projection.js").default} projection Projection.
   * @param {Object} params Params.
   * @return {string} Request URL.
   * @private
   */
  getRequestUrl_(extent, size, pixelRatio, projection, params) {

    assert(this.url_ !== undefined, 9); // `url` must be configured or set using `#setUrl()`

    params[this.v13_ ? 'CRS' : 'SRS'] = projection.getCode();

    if (!('STYLES' in this.params_)) {
      params['STYLES'] = '';
    }

    if (pixelRatio != 1) {
      switch (this.serverType_) {
        case WMSServerType.GEOSERVER:
          const dpi = (90 * pixelRatio + 0.5) | 0;
          if ('FORMAT_OPTIONS' in params) {
            params['FORMAT_OPTIONS'] += ';dpi:' + dpi;
          } else {
            params['FORMAT_OPTIONS'] = 'dpi:' + dpi;
          }
          break;
        case WMSServerType.MAPSERVER:
          params['MAP_RESOLUTION'] = 90 * pixelRatio;
          break;
        case WMSServerType.CARMENTA_SERVER:
        case WMSServerType.QGIS:
          params['DPI'] = 90 * pixelRatio;
          break;
        default:
          assert(false, 8); // Unknown `serverType` configured
          break;
      }
    }

    params['WIDTH'] = size[0];
    params['HEIGHT'] = size[1];

    const axisOrientation = projection.getAxisOrientation();
    let bbox;
    if (this.v13_ && axisOrientation.substr(0, 2) == 'ne') {
      bbox = [extent[1], extent[0], extent[3], extent[2]];
    } else {
      bbox = extent;
    }
    params['BBOX'] = bbox.join(',');

    return appendParams(/** @type {string} */ (this.url_), params);
  }

  /**
   * Return the URL used for this WMS source.
   * @return {string|undefined} URL.
   * @api
   */
  getUrl() {
    return this.url_;
  }

  /**
   * Set the image load function of the source.
   * @param {import("../Image.js").LoadFunction} imageLoadFunction Image load function.
   * @api
   */
  setImageLoadFunction(imageLoadFunction) {
    this.image_ = null;
    this.imageLoadFunction_ = imageLoadFunction;
    this.changed();
  }

  /**
   * Set the URL to use for requests.
   * @param {string|undefined} url URL.
   * @api
   */
  setUrl(url) {
    if (url != this.url_) {
      this.url_ = url;
      this.image_ = null;
      this.changed();
    }
  }

  /**
   * Update the user-provided params.
   * @param {Object} params Params.
   * @api
   */
  updateParams(params) {
    assign(this.params_, params);
    this.updateV13_();
    this.image_ = null;
    this.changed();
  }

  /**
   * @private
   */
  updateV13_() {
    const version = this.params_['VERSION'] || DEFAULT_WMS_VERSION;
    this.v13_ = compareVersions(version, '1.3') >= 0;
  }
}


export default ImageWMS;
