import type { Viewer } from "cesium"
import {
  PointPrimitiveCollection, ScreenSpaceEventHandler, ScreenSpaceEventType,
  defaultValue, Color, Cartesian3, Material, PrimitiveCollection, ArcType, GeometryInstance, PolylineGeometry, Primitive, PolylineMaterialAppearance, CircleGeometry, MaterialAppearance
} from "cesium"
import { cartesian3ToCoordinate, convertLength, createUid, getDistance, windowPositionToEllipsoidCartesian, type Coordinate, coordinateToCartesian3, isSameCoordinate } from "../../.."
import Tooltip from "../../../utils/tooltip"
import Cursor from "../../../utils/cursor"
import { Settings } from "../../config"
import { getBreakPosition, getIconLinePositions, type CustomGraphPoints, getSplinePositions } from "../utils/creatMilitary"



export interface PolylineDrawOption {
  id?: string
  show?: boolean
  pointSize?: number
  lineWidth?: number
  color?: Color
  material: Material
  arcType?: ArcType
  distanceType?: "米" | "千米" | "海里"
}


const drawMineLay = (viewer: Viewer, options: Record<string, any>, callback: (e:any)=>void, cancelCallback?: ()=>void) => {
  // 解析参数
  const uuid = options.id || createUid()
  const featureId = { uuid }
  const show = defaultValue(options.show, true)
  const pixelSize = defaultValue(options.pointSize, 6)
  const width = defaultValue(options.lineWidth, 3)
  const color = options.color || Color.fromCssColorString("#FFFFFF")
  const material = Material.fromType("Color", {
    color: color
  })
  // 折线类型
  const arcType = defaultValue(options.arcType, ArcType.GEODESIC)
  // 是否允许点击拾取
  const allowPicking = defaultValue(options.allowPick, true)

  // 关于深度的设置
  const haveHeight = defaultValue(options.haveHeight, false)
  const defaultHeight = defaultValue(options.defaultHeight, 0)
  // 双击间隔
  const DBCLICK_INTERVAL = Settings.LEFT_DOUBLE_CLICK_TIME_INTERVAL
  // 椭球
  const ellipsoid = viewer.scene.globe.ellipsoid

  // 操作提示文本
  const toolTipText = {
    start: "单击开始绘制</br>右键取消绘制",
    end: "单击或双击结束绘制</br>右键取消绘制"
  }
  const tooltip = new Tooltip(viewer.container)
  tooltip.setVisible(true)
  // 设置光标样式
  Cursor.setStyle("pen", viewer)

  // 绘制完成或取消，销毁资源
  const onFinished = () => {
    // 销毁提示文本
    tooltip.destroy()
    // 还原光标样式
    Cursor.recover(viewer)
    // 销毁handelr
    _handler.destroy()
    // 删除事件
    viewer.scene.preUpdate.removeEventListener(_preUpdateHandler)
    // 删除点
    viewer.scene.primitives.remove(tempPointCollection)
    viewer.scene.primitives.remove(movingLineCollection)
  }

  // 绘制过程重临时创建的 顶点 和 线段
  const tempPointCollection = new PointPrimitiveCollection()
  const movingLineCollection = new PrimitiveCollection()
  viewer.scene.primitives.add(tempPointCollection)
  viewer.scene.primitives.add(movingLineCollection)
  // // 记录顶点的坐标 (插值后的)
  // 记录控制点坐标
  const controlPoints: Coordinate[] = []
  // 记录临时坐标
  let tempCirclePoints: Cartesian3[] = [] // 点
  let tempLinePositions: Cartesian3[][] = [] // 线
  let tempLineCoordinates: Coordinate[] = []
  // 是否要更新
  let changedFlag = false


  const getPrimitive = (positions: Cartesian3[], linePositions:Cartesian3[], id: any = undefined, allowPicking = false) => {
    // 添加圆形点位
    const geometryInstances: GeometryInstance[] = []
    positions.forEach(item => {
      geometryInstances.push(new GeometryInstance({
        geometry: new CircleGeometry({
          center: item,
          radius: 5000
        }),
        id: id
      }))
    })
    const circlePrimitive = new Primitive({
      appearance: new MaterialAppearance({
        material: material
      }),
      geometryInstances: geometryInstances,
      releaseGeometryInstances: true,
      asynchronous: false,
      allowPicking: allowPicking
    })

    // 添加自定义图形
    const polylinePrimitive = new Primitive({
      appearance: new PolylineMaterialAppearance({
        material: material
      }),
      geometryInstances: [new GeometryInstance({
        geometry: new PolylineGeometry({
          positions: linePositions,
          width: width,
          arcType: arcType
        }),
        id: id
      })],
      releaseGeometryInstances: true,
      asynchronous: false,
      allowPicking: allowPicking
    })
    const primitive = new PrimitiveCollection()
    primitive.add(circlePrimitive)
    primitive.add(polylinePrimitive)
    return primitive
  }

  // 处理坐标
  const dealWithCoordinate = (cartesian3: Cartesian3): [Cartesian3, Coordinate] => {
    // 处理深度
    if (haveHeight) {
      const coor = cartesian3ToCoordinate(cartesian3, viewer)
      const newCoor = {
        longitude: coor.longitude,
        latitude: coor.latitude,
        height: defaultHeight
      }
      const c3 = coordinateToCartesian3(newCoor, viewer)
      return [c3, newCoor]
    } else {
      const coor = cartesian3ToCoordinate(cartesian3, viewer)
      return [cartesian3, coor]
    }
  }

  const endDraw = () => {
    const primitive = getPrimitive(tempCirclePoints, tempLinePositions[0], featureId, allowPicking)
    const result = {
      p: primitive,
      positions: {
        line: tempLinePositions.map(item => {
          return item.map(it => cartesian3ToCoordinate(it, viewer))
        }),
        circle: tempCirclePoints.map(item => cartesian3ToCoordinate(item, viewer))
      },
      coordinates: tempLineCoordinates,
      id: featureId
    }
    onFinished()
    // 回调函数
    callback && callback(result)
  }

  // 无闪烁更新
  const _preUpdateHandler = () => {
    if (changedFlag) {
      changedFlag = false
      const primitive = getPrimitive(tempCirclePoints, tempLinePositions[0])
      if (movingLineCollection.length > 0) {
        movingLineCollection.removeAll()
      }
      movingLineCollection.add(primitive)
    }
  }
  viewer.scene.preUpdate.addEventListener(_preUpdateHandler)

  // 准备工作
  const _handler = new ScreenSpaceEventHandler(viewer.canvas)
  let validClick = false
  let lastClickTime = Date.now()

  // -- 左击
  _handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
    const currentTime = Date.now()
    const timeInterval = currentTime - lastClickTime
    lastClickTime = currentTime

    if (timeInterval > DBCLICK_INTERVAL) {
      // 屏幕坐标转三维笛卡尔坐标
      const cartesian3 = windowPositionToEllipsoidCartesian(click.position, viewer)
      // 没选中地球上的坐标
      if (cartesian3 === undefined) {
        // validClick = false
        return
      }

      const [c3, coor] = dealWithCoordinate(cartesian3)
      // 对点击同一个点的情况做特殊处理
      const cLength = controlPoints.length
      if (cLength > 0) {
        const sample = controlPoints[cLength - 1]
        if (isSameCoordinate(sample, coor)) {
          validClick = false
          return
        }
      }
      // 第二个点表明绘制完成
      if (cLength === 1) {
        endDraw()
        return
      }

      validClick = true
      // 记录控制点坐标
      controlPoints.push(coor)
      // 绘制顶点
      tempPointCollection.add({ show, color, pixelSize, position: c3 })
    }
  }, ScreenSpaceEventType.LEFT_CLICK)

  // -- 移动
  _handler.setInputAction((move: ScreenSpaceEventHandler.MotionEvent) => {
    const cLength = controlPoints.length
    if (cLength === 0) {
      tooltip.showAt(move.endPosition, toolTipText.start)
      return
    }
    // 计算鼠标位置处的坐标
    const cartesian3 = windowPositionToEllipsoidCartesian(move.endPosition, viewer)
    if (!cartesian3) { return }


    const [c3, coor] = dealWithCoordinate(cartesian3)
    // 在preUpdate时更新航路
    changedFlag = true

    tempLineCoordinates = [...controlPoints, coor]

    const coordinates: number[] = []
    tempLineCoordinates.forEach(item => {
      coordinates.push(item.longitude, item.latitude)
    })
    const { positions, angle, radius } = getSplinePositions(Cartesian3.fromDegreesArray(coordinates))!
    const points: CustomGraphPoints = [
      [1, 0], [0.5, 0.5], [-1, 0.5], [-1, -0.5], [0.5, -0.5], [1, 0]
    ]
    tempCirclePoints = positions
    tempLinePositions = getIconLinePositions(positions[3], 90 - angle, 0.4, [points])

    // 更新tooltip位置和内容
    tooltip.showAt(move.endPosition, toolTipText.end)

  }, ScreenSpaceEventType.MOUSE_MOVE)

  // -- 左双击
  _handler.setInputAction(() => {
    if (controlPoints.length < 2) {
      message.error("请至少选择两个坐标点")
      return
    }
    endDraw()

  }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

  // -- 右击
  _handler.setInputAction(() => {
    onFinished()
    cancelCallback && cancelCallback()
  }, ScreenSpaceEventType.RIGHT_CLICK)

  return onFinished
}

export default drawMineLay
